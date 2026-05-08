// ─── ABIs ────────────────────────────────────────────────────────────────────

const FACTORY_ABI = [
  "function token() view returns (address)",
  "function createFeeWei() view returns (uint256)",
  "function minDuration() view returns (uint256)",
  "function maxDuration() view returns (uint256)",
  "function minStrikeTime() view returns (uint256)",
  "function maxStrikeTime() view returns (uint256)",
  "function createOption(uint256,uint256,uint256,uint256,uint8) payable returns (address)",
  "function allOptionsLength() view returns (uint256)",
  "function getAllOptionsBatch(uint256,uint256) view returns (address[])",
  "function relayRecordActualTime(address optionAddr, uint256 actualTime)",
  "function relayChangeOracle(address optionAddr, address newOracle)",
  "event OptionCreated(address indexed option, address indexed writer, uint8 optionType, uint256 strikeTime, uint256 premium, uint256 collateral, uint256 expiry)"
];

const TOKEN_ABI = [
  "function mint(address to, uint256 amount)",
  "function owner() view returns (address)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

const OPTION_ABI = [
  // Immutable params
  "function token() view returns (address)",
  "function writer() view returns (address)",
  "function oracle() view returns (address)",
  "function relayCaller() view returns (address)",
  "function strikeTime() view returns (uint256)",
  "function premium() view returns (uint256)",
  "function collateralAmount() view returns (uint256)",
  "function expiry() view returns (uint256)",
  "function createdAt() view returns (uint256)",
  "function optionType() view returns (uint8)",
  // Mutable state
  "function buyer() view returns (address)",
  "function isDeposited() view returns (bool)",
  "function isActive() view returns (bool)",
  "function isExercised() view returns (bool)",
  "function isCanceled() view returns (bool)",
  "function actualWaitTime() view returns (uint256)",
  "function actualTimeRecorded() view returns (bool)",
  "function isBuyable() view returns (bool)",
  "function contractBalance() view returns (uint256)",
  // Actions
  "function deposit()",
  "function buyOption()",
  "function cancelIfUnbought()",
  "function cancelIfInactive()",
  "function exercise()",
  "function retrieveExpired()",
  "function changeOracle(address _newOracle)"
];

// ─── Constants ────────────────────────────────────────────────────────────────

const TARGET_CHAIN_ID  = 31337n;
const TARGET_CHAIN_HEX = "0x7a69";

// ─── State ────────────────────────────────────────────────────────────────────

let provider;
let signer;
let account;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const els = {
  // Connection
  connectBtn:       document.getElementById("connectBtn"),
  loadConfigBtn:    document.getElementById("loadConfigBtn"),
  factoryAddress:   document.getElementById("factoryAddress"),
  accountInfo:      document.getElementById("accountInfo"),
  // Factory read
  readFactoryBtn:   document.getElementById("readFactoryBtn"),
  listOptionsBtn:   document.getElementById("listOptionsBtn"),
  factoryReadout:   document.getElementById("factoryReadout"),
  // Create option
  optionType:       document.getElementById("optionType"),
  strikeTime:       document.getElementById("strikeTime"),
  premium:          document.getElementById("premium"),
  collateral:       document.getElementById("collateral"),
  duration:         document.getElementById("duration"),
  mintAmount:       document.getElementById("mintAmount"),
  mintBtn:          document.getElementById("mintBtn"),
  createOptionBtn:  document.getElementById("createOptionBtn"),
  txLog:            document.getElementById("txLog"),
  // Option inspector
  optionAddress:    document.getElementById("optionAddress"),
  loadOptionBtn:    document.getElementById("loadOptionBtn"),
  optionState:      document.getElementById("optionState"),
  // Writer actions
  approveDepositBtn: document.getElementById("approveDepositBtn"),
  cancelUnboughtBtn: document.getElementById("cancelUnboughtBtn"),
  retrieveExpiredBtn:document.getElementById("retrieveExpiredBtn"),
  newOracleAddress:  document.getElementById("newOracleAddress"),
  changeOracleBtn:   document.getElementById("changeOracleBtn"),
  writerLog:         document.getElementById("writerLog"),
  // Buyer actions
  approveBuyBtn:    document.getElementById("approveBuyBtn"),
  exerciseBtn:      document.getElementById("exerciseBtn"),
  buyerLog:         document.getElementById("buyerLog"),
  // Admin actions
  actualWaitTime:   document.getElementById("actualWaitTime"),
  recordTimeBtn:    document.getElementById("recordTimeBtn"),
  adminLog:         document.getElementById("adminLog")
};

// ─── Logging helpers ──────────────────────────────────────────────────────────

function log(line) {
  els.txLog.textContent = `${line}\n${els.txLog.textContent}`;
}

function logWriter(line) {
  els.writerLog.textContent = `${line}\n${els.writerLog.textContent}`;
}

function logBuyer(line) {
  els.buyerLog.textContent = `${line}\n${els.buyerLog.textContent}`;
}

function logAdmin(line) {
  els.adminLog.textContent = `${line}\n${els.adminLog.textContent}`;
}

function setAccountStatus(text) {
  els.accountInfo.textContent = text;
}

// ─── Enable / disable all action buttons ─────────────────────────────────────

function setActionButtonsEnabled(enabled) {
  const ids = [
    "readFactoryBtn", "listOptionsBtn",
    "mintBtn", "createOptionBtn",
    "loadOptionBtn",
    "approveDepositBtn", "cancelUnboughtBtn", "retrieveExpiredBtn", "changeOracleBtn",
    "approveBuyBtn", "exerciseBtn",
    "recordTimeBtn"
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  });
}

// ─── Error formatting ─────────────────────────────────────────────────────────

function friendlyError(err) {
  if (!err) return "Unknown error";
  return (
    err.shortMessage ||
    err.reason ||
    err.message ||
    (err.error && err.error.message) ||
    "Unknown error"
  );
}

// ─── Contract helpers ─────────────────────────────────────────────────────────

function getFactory() {
  const addr = els.factoryAddress.value.trim();
  if (!addr) throw new Error("Factory address is empty");
  return new ethers.Contract(addr, FACTORY_ABI, signer);
}

function getOption() {
  const addr = els.optionAddress.value.trim();
  if (!addr) throw new Error("Option address is empty — load an option first.");
  return new ethers.Contract(addr, OPTION_ABI, signer);
}

function ensureConnected() {
  if (!provider || !signer || !account) {
    throw new Error("Wallet not connected. Please click Connect MetaMask first.");
  }
}

// ─── 1. Connect wallet ────────────────────────────────────────────────────────

async function connectWallet() {
  if (!window.ethereum) throw new Error("MetaMask not found");
  if (!window.ethers)   throw new Error("ethers library not loaded (check network/CDN)");

  setAccountStatus("Wallet: connecting...");

  await window.ethereum.request({ method: "eth_requestAccounts" });

  provider = new ethers.BrowserProvider(window.ethereum);
  signer   = await provider.getSigner();
  account  = await signer.getAddress();
  let net  = await provider.getNetwork();

  if (net.chainId !== TARGET_CHAIN_ID) {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: TARGET_CHAIN_HEX }]
      });
    } catch (switchErr) {
      if (switchErr && switchErr.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: TARGET_CHAIN_HEX,
            chainName: "Hardhat Local",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["http://127.0.0.1:8545"]
          }]
        });
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: TARGET_CHAIN_HEX }]
        });
      } else {
        throw new Error(`Please switch MetaMask to Hardhat Local (31337). ${friendlyError(switchErr)}`);
      }
    }
    net = await provider.getNetwork();
  }

  if (net.chainId !== TARGET_CHAIN_ID) {
    throw new Error(`Wrong network: expected ${TARGET_CHAIN_ID}, got ${net.chainId}`);
  }

  setAccountStatus(`Wallet: ${account} | chainId: ${net.chainId}`);
}

// ─── 2. Load deployment config ────────────────────────────────────────────────

async function loadLocalDeployment() {
  const res = await fetch("./deployments.localhost.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Cannot load deployments.localhost.json. Run deploy first.");
  const data = await res.json();
  els.factoryAddress.value = data.elevatorOptionFactory || "";
  log(`Loaded deployment. Factory=${data.elevatorOptionFactory}`);
}

// ─── 3. Factory read ──────────────────────────────────────────────────────────

async function readFactoryRules() {
  ensureConnected();
  const factory = getFactory();
  const [createFeeWei, minDuration, maxDuration, minStrikeTime, maxStrikeTime, token] =
    await Promise.all([
      factory.createFeeWei(),
      factory.minDuration(),
      factory.maxDuration(),
      factory.minStrikeTime(),
      factory.maxStrikeTime(),
      factory.token()
    ]);

  els.factoryReadout.textContent = JSON.stringify({
    token,
    createFeeWei:    createFeeWei.toString(),
    minDurationSec:  minDuration.toString(),
    maxDurationSec:  maxDuration.toString(),
    minStrikeTimeMin: minStrikeTime.toString(),
    maxStrikeTimeMin: maxStrikeTime.toString()
  }, null, 2);
}

async function listRecentOptions() {
  ensureConnected();
  const factory = getFactory();
  const total = Number(await factory.allOptionsLength());
  const start = total > 10 ? total - 10 : 0;
  const list  = await factory.getAllOptionsBatch(start, 10);

  els.factoryReadout.textContent = JSON.stringify({ total, showingFrom: start, options: list }, null, 2);
}

// ─── 4. Mint PU ───────────────────────────────────────────────────────────────

async function mintPU() {
  ensureConnected();
  const factory  = getFactory();
  const tokenAddr = await factory.token();
  const token    = new ethers.Contract(tokenAddr, TOKEN_ABI, signer);
  const owner    = await token.owner();

  if (owner.toLowerCase() !== account.toLowerCase()) {
    throw new Error(`Mint requires token owner. Connected=${account}, owner=${owner}`);
  }

  const amt = ethers.parseUnits(els.mintAmount.value || "0", 18);
  const tx  = await token.mint(account, amt);
  log(`Mint sent: ${tx.hash}`);
  await tx.wait();
  const bal = await token.balanceOf(account);
  log(`Mint confirmed. Balance=${ethers.formatUnits(bal, 18)} PU`);
}

// ─── 5. Create option ─────────────────────────────────────────────────────────

async function createOption() {
  ensureConnected();
  const factory    = getFactory();
  const strikeTime = BigInt(els.strikeTime.value);
  const premium    = ethers.parseUnits(els.premium.value || "0", 18);
  const collateral = ethers.parseUnits(els.collateral.value || "0", 18);
  const duration   = BigInt(els.duration.value);
  const optionType = Number(els.optionType.value);

  const [fee, minDuration, maxDuration, minStrike, maxStrike] = await Promise.all([
    factory.createFeeWei(),
    factory.minDuration(),
    factory.maxDuration(),
    factory.minStrikeTime(),
    factory.maxStrikeTime()
  ]);

  if (duration < minDuration || duration > maxDuration) {
    throw new Error(`Duration out of range: ${duration} (allowed ${minDuration}-${maxDuration})`);
  }
  if (strikeTime < minStrike || strikeTime > maxStrike) {
    throw new Error(`Strike out of range: ${strikeTime} (allowed ${minStrike}-${maxStrike})`);
  }

  const tx = await factory.createOption(strikeTime, premium, collateral, duration, optionType, {
    value: fee
  });
  log(`CreateOption sent: ${tx.hash}`);
  const receipt = await tx.wait();

  const iface = new ethers.Interface(FACTORY_ABI);
  let optionAddr = "<not parsed>";
  for (const lg of receipt.logs) {
    try {
      const parsed = iface.parseLog(lg);
      if (parsed && parsed.name === "OptionCreated") {
        optionAddr = parsed.args.option;
        break;
      }
    } catch (_) { /* ignore non-factory logs */ }
  }

  log(`CreateOption confirmed. Option=${optionAddr}`);

  // Auto-fill the option address field for convenience
  if (optionAddr !== "<not parsed>") {
    els.optionAddress.value = optionAddr;
    log(`Option address auto-filled in inspector.`);
  }
}

// ─── 6. Option Inspector ──────────────────────────────────────────────────────

async function loadOptionState() {
  ensureConnected();
  const option = getOption();

  const [
    writer, oracle, buyer,
    strikeTime, premium, collateralAmount,
    expiry, optionType,
    isDeposited, isActive, isExercised, isCanceled,
    actualWaitTime, actualTimeRecorded,
    isBuyable, contractBalance
  ] = await Promise.all([
    option.writer(),
    option.oracle(),
    option.buyer(),
    option.strikeTime(),
    option.premium(),
    option.collateralAmount(),
    option.expiry(),
    option.optionType(),
    option.isDeposited(),
    option.isActive(),
    option.isExercised(),
    option.isCanceled(),
    option.actualWaitTime(),
    option.actualTimeRecorded(),
    option.isBuyable(),
    option.contractBalance()
  ]);

  const now       = Math.floor(Date.now() / 1000);
  const expiryNum = Number(expiry);
  const expiryStr = new Date(expiryNum * 1000).toLocaleString();
  const isExpired = now >= expiryNum;

  const statusFlags = [];
  if (isCanceled)          statusFlags.push("CANCELED");
  else if (isExercised)    statusFlags.push("EXERCISED");
  else if (!isDeposited)   statusFlags.push("awaiting deposit");
  else if (!isActive)      statusFlags.push("deposited, awaiting buyer");
  else if (!actualTimeRecorded) statusFlags.push(isExpired ? "expired, awaiting oracle" : "active (not expired yet)");
  else                     statusFlags.push("time recorded — ready for exercise/retrieve");

  els.optionState.textContent = JSON.stringify({
    type:              optionType === 0n ? "CALL" : "PUT",
    status:            statusFlags.join(", "),
    writer,
    oracle,
    buyer:             buyer === "0x0000000000000000000000000000000000000000" ? "(none)" : buyer,
    strikeTime:        `${strikeTime.toString()} min`,
    premium:           `${ethers.formatUnits(premium, 18)} PU`,
    collateral:        `${ethers.formatUnits(collateralAmount, 18)} PU`,
    contractBalance:   `${ethers.formatUnits(contractBalance, 18)} PU`,
    expiry:            `${expiryStr} (${isExpired ? "EXPIRED" : "active"})`,
    isDeposited,
    isActive,
    isExercised,
    isCanceled,
    isBuyable,
    actualTimeRecorded,
    actualWaitTime:    actualTimeRecorded ? `${actualWaitTime.toString()} min` : "(not recorded)"
  }, null, 2);
}

// ─── 7. Writer: Approve + Deposit ────────────────────────────────────────────

async function approveAndDeposit() {
  ensureConnected();
  const option  = getOption();
  const optAddr = els.optionAddress.value.trim();

  const [tokenAddr, collateralAmount] = await Promise.all([
    option.token(),
    option.collateralAmount()
  ]);

  const token = new ethers.Contract(tokenAddr, TOKEN_ABI, signer);

  logWriter(`Approving ${ethers.formatUnits(collateralAmount, 18)} PU for option contract...`);
  const approveTx = await token.approve(optAddr, collateralAmount);
  logWriter(`Approve sent: ${approveTx.hash}`);
  await approveTx.wait();
  logWriter("Approve confirmed.");

  logWriter("Depositing collateral...");
  const depositTx = await option.deposit();
  logWriter(`Deposit sent: ${depositTx.hash}`);
  await depositTx.wait();
  logWriter("Deposit confirmed. Collateral is now locked in the option contract.");

  await loadOptionState();
}

// ─── 8. Writer: Cancel if unbought ───────────────────────────────────────────

async function cancelIfUnbought() {
  ensureConnected();
  const option = getOption();
  logWriter("Canceling unbought option...");
  const tx = await option.cancelIfUnbought();
  logWriter(`Cancel sent: ${tx.hash}`);
  await tx.wait();
  logWriter("Canceled. Collateral returned to writer.");
  await loadOptionState();
}

// ─── 9. Writer: Retrieve expired ─────────────────────────────────────────────

async function retrieveExpired() {
  ensureConnected();
  const option = getOption();
  logWriter("Retrieving expired collateral...");
  const tx = await option.retrieveExpired();
  logWriter(`RetrieveExpired sent: ${tx.hash}`);
  await tx.wait();
  logWriter("Collateral retrieved. Option closed.");
  await loadOptionState();
}

// ─── 10. Writer: Change oracle ────────────────────────────────────────────────

async function changeOracle() {
  ensureConnected();
  const factory    = getFactory();
  const optAddr    = els.optionAddress.value.trim();
  if (!optAddr) throw new Error("Option address is empty — load an option first.");
  const newOracle  = els.newOracleAddress.value.trim();
  if (!newOracle) throw new Error("New oracle address is empty.");

  logWriter(`Relaying oracle change to ${newOracle}...`);
  const tx = await factory.relayChangeOracle(optAddr, newOracle);
  logWriter(`ChangeOracle sent: ${tx.hash}`);
  await tx.wait();
  logWriter(`Oracle updated to ${newOracle}.`);
  await loadOptionState();
}

// ─── 11. Buyer: Approve + Buy option ─────────────────────────────────────────

async function approveAndBuy() {
  ensureConnected();
  const option  = getOption();
  const optAddr = els.optionAddress.value.trim();

  const [tokenAddr, premium] = await Promise.all([
    option.token(),
    option.premium()
  ]);

  const token = new ethers.Contract(tokenAddr, TOKEN_ABI, signer);

  logBuyer(`Approving ${ethers.formatUnits(premium, 18)} PU premium...`);
  const approveTx = await token.approve(optAddr, premium);
  logBuyer(`Approve sent: ${approveTx.hash}`);
  await approveTx.wait();
  logBuyer("Approve confirmed.");

  logBuyer("Buying option...");
  const buyTx = await option.buyOption();
  logBuyer(`BuyOption sent: ${buyTx.hash}`);
  await buyTx.wait();
  logBuyer("Option bought! Premium paid to writer. Option is now active.");

  await loadOptionState();
}

// ─── 12. Buyer: Exercise ──────────────────────────────────────────────────────

async function exercise() {
  ensureConnected();
  const option = getOption();
  logBuyer("Exercising option...");
  const tx = await option.exercise();
  logBuyer(`Exercise sent: ${tx.hash}`);
  await tx.wait();
  logBuyer("Exercised! Collateral transferred to buyer.");
  await loadOptionState();
}

// ─── 13. Admin: Record actual time ───────────────────────────────────────────

async function recordActualTime() {
  ensureConnected();
  const factory  = getFactory();
  const optAddr  = els.optionAddress.value.trim();
  if (!optAddr) throw new Error("Option address is empty — load an option first.");

  const actualTime = BigInt(els.actualWaitTime.value);
  logAdmin(`Recording actual wait time: ${actualTime} minutes...`);

  const tx = await factory.relayRecordActualTime(optAddr, actualTime);
  logAdmin(`RecordActualTime sent: ${tx.hash}`);
  await tx.wait();
  logAdmin(`Actual time recorded: ${actualTime} min. Settlement can now proceed.`);

  await loadOptionState();
}

// ─── Event listeners ──────────────────────────────────────────────────────────

els.connectBtn.addEventListener("click", async () => {
  try {
    await connectWallet();
    setActionButtonsEnabled(true);
    log("Wallet connected on Hardhat Local (31337).");
  } catch (err) {
    setActionButtonsEnabled(false);
    setAccountStatus(`Wallet connect error: ${friendlyError(err)}`);
    log(`Connect failed: ${friendlyError(err)}`);
  }
});

els.loadConfigBtn.addEventListener("click", async () => {
  try {
    await loadLocalDeployment();
  } catch (err) {
    log(`Load config failed: ${friendlyError(err)}`);
  }
});

els.readFactoryBtn.addEventListener("click", async () => {
  try {
    await readFactoryRules();
    log("Factory rules fetched.");
  } catch (err) {
    log(`Read failed: ${friendlyError(err)}`);
  }
});

els.listOptionsBtn.addEventListener("click", async () => {
  try {
    await listRecentOptions();
    log("Option list fetched.");
  } catch (err) {
    log(`List failed: ${friendlyError(err)}`);
  }
});

els.mintBtn.addEventListener("click", async () => {
  try {
    await mintPU();
  } catch (err) {
    log(`Mint failed: ${friendlyError(err)}`);
  }
});

els.createOptionBtn.addEventListener("click", async () => {
  try {
    await createOption();
  } catch (err) {
    log(`Create failed: ${friendlyError(err)}`);
  }
});

els.loadOptionBtn.addEventListener("click", async () => {
  try {
    await loadOptionState();
    log("Option state loaded.");
  } catch (err) {
    els.optionState.textContent = `Error: ${friendlyError(err)}`;
    log(`Load option failed: ${friendlyError(err)}`);
  }
});

els.approveDepositBtn.addEventListener("click", async () => {
  try {
    await approveAndDeposit();
  } catch (err) {
    logWriter(`Deposit failed: ${friendlyError(err)}`);
  }
});

els.cancelUnboughtBtn.addEventListener("click", async () => {
  try {
    await cancelIfUnbought();
  } catch (err) {
    logWriter(`Cancel failed: ${friendlyError(err)}`);
  }
});

els.retrieveExpiredBtn.addEventListener("click", async () => {
  try {
    await retrieveExpired();
  } catch (err) {
    logWriter(`Retrieve failed: ${friendlyError(err)}`);
  }
});

els.changeOracleBtn.addEventListener("click", async () => {
  try {
    await changeOracle();
  } catch (err) {
    logWriter(`Change oracle failed: ${friendlyError(err)}`);
  }
});

els.approveBuyBtn.addEventListener("click", async () => {
  try {
    await approveAndBuy();
  } catch (err) {
    logBuyer(`Buy failed: ${friendlyError(err)}`);
  }
});

els.exerciseBtn.addEventListener("click", async () => {
  try {
    await exercise();
  } catch (err) {
    logBuyer(`Exercise failed: ${friendlyError(err)}`);
  }
});

els.recordTimeBtn.addEventListener("click", async () => {
  try {
    await recordActualTime();
  } catch (err) {
    logAdmin(`Record time failed: ${friendlyError(err)}`);
  }
});

// ─── MetaMask account/chain change handlers ───────────────────────────────────

if (window.ethereum) {
  window.ethereum.on("accountsChanged", (accounts) => {
    if (!accounts || accounts.length === 0) {
      provider = signer = account = undefined;
      setActionButtonsEnabled(false);
      setAccountStatus("Wallet: disconnected");
      return;
    }
    setActionButtonsEnabled(false);
    setAccountStatus(`Wallet: ${accounts[0]} | reconnect recommended`);
  });

  window.ethereum.on("chainChanged", (_chainId) => {
    provider = signer = account = undefined;
    setActionButtonsEnabled(false);
    setAccountStatus(`Network changed (${_chainId}). Reconnect recommended.`);
  });
}

setActionButtonsEnabled(false);
