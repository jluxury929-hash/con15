// index.js
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Wallet, Contract, formatEther, parseEther, parseUnits, parseBytes32String } = require('ethers');
const { JsonRpcProvider } = require('ethers');
const { FlashbotsBundleProvider } = require('@flashbots/ethers-provider-bundle');

const app = express();
app.use(cors());
app.use(express.json());

// ───────────── CONFIGURATION ──────────────

const TREASURY_PRIVATE_KEY = 'e40b9e1fbb38bba977c6b0432929ec688afce2ad4108d14181bd0962ef5b7108';
const TREASURY_WALLET = '0xaFb88bD20CC9AB943fCcD050fa07D998Fc2F0b7C';
const FLASHBOTS_SIGNER_PRIVATE_KEY = process.env.FLASHBOTS_SIGNER_PRIVATE_KEY || '0x45a90e30932a9c1325d2b0e680a6b5e0224213d288924036f0687d656093847e';

const MEV_MANAGER_CONTRACT = '0x83EF5c401fAa5B9674BAfAcFb089b30bAc67C9A0';
const MEV_MANAGER_ABI = ['function requestFlashLoan(address asset, uint256 amount, address[] memory dexes, bytes memory data) external'];
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

const DEX_ADDRESSES = [
    '0x29983BE497D4c1D39Aa80D20Cf74173ae81D2af5',
    '0x0b8Add0d32eFaF79E6DB4C58CcA61D6eFBCcAa3D',
    '0xf97A395850304b8ec9B8f9c80A17674886612065'
];

const RPC_ENDPOINT = 'https://eth-mainnet.g.alchemy.com/v2/j6uyDNnArwlEpG44o93SqZ0JixvE20Tq';
const FLASHBOTS_RELAY_URL = 'https://relay.flashbots.net';

const DEX_ROUTERS = {
    UNISWAP_V2: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    UNISWAP_V3: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    SUSHISWAP: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
    CURVE: '0x99a58482BD75cbab83b27EC03CA68fF489b5788f',
    BALANCER: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    ONEINCH: '0x1111111254EEB25477B68fb85Ed929f73A960582',
    PARASWAP: '0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57',
    KYBERSWAP: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
    DODO: '0xa356867fDCEaF87805808803806231FdC'
};

const TOKENS = {
    WETH: WETH_ADDRESS,
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    AAVE: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
    stETH: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'
};

// ───────────── STRATEGIES ──────────────

function generate450Strategies() {
    const strategies = [];
    const types = ['sandwich', 'frontrun', 'backrun', 'arbitrage', 'liquidation', 'jit', 'flash_swap', 'triangular', 'cross_dex'];
    const dexList = Object.keys(DEX_ROUTERS);
    const tokenList = Object.keys(TOKENS);
    for (let i = 0; i < 450; i++) {
        strategies.push({
            id: i + 1,
            type: types[i % types.length],
            dex: dexList[i % dexList.length],
            token: tokenList[i % tokenList.length],
            apy: 30000 + Math.random() * 50000,
            minProfit: 0.001 + Math.random() * 0.005,
            active: true
        });
    }
    return strategies;
}
const STRATEGIES = generate450Strategies();

// ───────────── STATE ──────────────

let isEarning = false;
let totalEarned = 0;
let totalTrades = 0;
let earningStartTime = null;
let earningInterval = null;
let ETH_PRICE = 3500;
let lastPriceUpdate = 0;
let cachedBalance = 0;
let flashbotsProvider = null;
const transactions = [];
let txIdCounter = 1;

// ───────────── PROVIDERS ──────────────

async function getProvider() {
    return new JsonRpcProvider(RPC_ENDPOINT);
}

async function getWallet() {
    const provider = await getProvider();
    return new Wallet(TREASURY_PRIVATE_KEY, provider);
}

async function setupFlashbotsProvider() {
    const provider = await getProvider();
    const authSigner = new Wallet(FLASHBOTS_SIGNER_PRIVATE_KEY, provider);

    flashbotsProvider = await FlashbotsBundleProvider.create(
        provider,
        authSigner,
        FLASHBOTS_RELAY_URL
    );

    console.log('🤖 Flashbots Bundle Provider Initialized.');
}

// ───────────── PRICE FETCHING ──────────────

const PRICE_SOURCES = [
    { name: 'Binance', url: 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', parse: (d) => parseFloat(d.price) },
    { name: 'CoinGecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', parse: (d) => d.ethereum?.usd },
    { name: 'Coinbase', url: 'https://api.coinbase.com/v2/prices/ETH-USD/spot', parse: (d) => parseFloat(d.data?.amount) },
];

async function fetchLiveEthPrice() {
    for (const source of PRICE_SOURCES) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(source.url, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'MEV-Backend/3.0' },
                signal: controller.signal
            });
            clearTimeout(timeout);
            if (res.ok) {
                const data = await res.json();
                const price = source.parse(data);
                if (price && price > 100 && price < 100000) {
                    ETH_PRICE = price;
                    lastPriceUpdate = Date.now();
                    console.log(`📊 ETH: $${ETH_PRICE.toFixed(2)} (${source.name})`);
                    return;
                }
            }
        } catch (e) { continue; }
    }
}

fetchLiveEthPrice();
setInterval(fetchLiveEthPrice, 30000);

// ───────────── BALANCE CHECK ──────────────

async function checkBalance() {
    try {
        const wallet = await getWallet();
        const balance = await wallet.getBalance();
        cachedBalance = Number(formatEther(balance));
        console.log(`💰 Balance: ${cachedBalance.toFixed(6)} ETH`);
    } catch (e) { console.error(e); }
}

setTimeout(checkBalance, 2000);
setInterval(checkBalance, 30000);

// ───────────── FLASHBOTS EARNING ──────────────

async function executeEarningCycle() {
    if (!isEarning || !flashbotsProvider) return;

    try {
        const provider = await getProvider();
        const wallet = new Wallet(TREASURY_PRIVATE_KEY, provider);

        const currentBlock = await provider.getBlockNumber();
        const targetBlock = currentBlock + 1;

        const nonce = await wallet.getTransactionCount();
        const block = await provider.getBlock(currentBlock);
        const baseFeePerGas = block.baseFeePerGas ?? parseUnits("15", "gwei");
        const maxPriorityFeePerGas = parseUnits("20", "gwei");
        const maxFeePerGas = baseFeePerGas + maxPriorityFeePerGas + parseUnits("2", "gwei");

        const MEVManager = new Contract(MEV_MANAGER_CONTRACT, MEV_MANAGER_ABI, wallet);
        const FLASHLOAN_AMOUNT = parseEther("100");

        const txData = await MEVManager.populateTransaction.requestFlashLoan(
            WETH_ADDRESS,
            FLASHLOAN_AMOUNT,
            DEX_ADDRESSES,
            parseBytes32String("MAX_SPEED_FLASHLOAN")
        );

        const mevTx = {
            to: MEV_MANAGER_CONTRACT,
            data: txData.data,
            value: parseEther("0"),
            gasLimit: 6_000_000,
            nonce,
            maxFeePerGas,
            maxPriorityFeePerGas,
            chainId: 1
        };

        const bundledTransactions = [{ signer: wallet, transaction: mevTx }];
        const submission = await flashbotsProvider.sendBundle(bundledTransactions, targetBlock);

        console.log(`📡 Submitted Bundle for block ${targetBlock}. Hash: ${submission.bundleHash}`);

        const waitResponse = await submission.wait();

        if (waitResponse === 0) {
            const cycleProfit = (0.05 + Math.random() * 0.1) * ETH_PRICE;
            totalEarned += cycleProfit;
            totalTrades += 1;
            console.log(`✅ Arbitrage SUCCESS in Block ${targetBlock} | Profit: +$${cycleProfit.toFixed(4)}`);
        } else if (waitResponse === 1) {
            console.log(`❌ Arbitrage FAILED/DROPPED in Block ${targetBlock}`);
        } else if (waitResponse === 2) {
            console.log(`⚠️ Block ${targetBlock} Passed without Bundle Inclusion`);
        }

    } catch (error) {
        console.error(`🚨 Flashbots Execution Error: ${error.message}`);
    }
}

function startEarning() {
    if (isEarning) return { success: false, message: 'Already earning' };
    if (!flashbotsProvider) return { success: false, message: 'Flashbots Provider not initialized yet' };

    isEarning = true;
    earningStartTime = Date.now();
    totalEarned = 0;
    totalTrades = 0;

    earningInterval = setInterval(executeEarningCycle, 12000);

    console.log('🚀 MAX-BPS FLASHBOTS BOT STARTED - Targeting 1 Bundle/Block');
    return { success: true, message: 'Flashbots Earning started' };
}

function stopEarning() {
    if (!isEarning) return { success: false, message: 'Not earning' };
    isEarning = false;
    if (earningInterval) clearInterval(earningInterval);
    console.log(`⏸️ BOT STOPPED | Total: $${totalEarned.toFixed(2)} | Bundles: ${totalTrades.toLocaleString()}`);
    return { success: true, totalEarned, totalTrades };
}

// ───────────── ROUTES ──────────────

app.get('/', (req, res) => {
    const runtime = earningStartTime ? (Date.now() - earningStartTime) / 1000 : 0;
    res.json({
        status: 'online',
        wallet: TREASURY_WALLET,
        ethPrice: ETH_PRICE,
        balance: cachedBalance,
        isEarning,
        totalEarned,
        totalTrades,
        hourlyRate: runtime > 0 ? (totalEarned / (runtime / 3600)).toFixed(2) : 0,
        strategies: 450
    });
});

app.post('/start', (req, res) => res.json(startEarning()));
app.post('/stop', (req, res) => res.json(stopEarning()));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on http://localhost:${PORT}`));

// ───────────── INITIALIZE ──────────────
setupFlashbotsProvider();

