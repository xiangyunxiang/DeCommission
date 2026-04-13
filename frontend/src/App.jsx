/**
 * App.jsx — Global Entry Point
 *
 * UX Flow:
 *   Guest (no wallet)
 *     └─ GuestPage: read-only Browse Artists + Browse Open Listings
 *        └─ "Connect Wallet" → full Dashboard
 *
 * Key design decision:
 *   Client / Artist / Juror are ROLES within a transaction, not separate identities.
 *   One wallet address can do all three. No need for separate accounts.
 */

import { useState, useEffect } from "react"
import { ethers } from "ethers"
import { CONTRACT_ADDRESS, CONTRACT_ABI } from "./contract/config.js"
import ClientPage from "./pages/ClientPage"
import ArtistPage from "./pages/ArtistPage"
import JurorPage  from "./pages/JurorPage"

// ── MODULE 1: Mock data for demo ───────────────────────────────────────────
// Change to 10 to see Juror tab unlocked
// Production: sum of Client status-3 orders + Artist status-3 orders
const MOCK_COMPLETED_COUNT   = 10
const MOCK_JUROR_INVITATIONS = 2

// ── MODULE 1: Guest preview data (visible without wallet) ──────────────────
const GUEST_ARTISTS = [
  { id: 1, address: "0x1A2B...3C4D", style: "Cyberpunk / Cel Shading",      priceRange: "0.05–0.2 ETH",  active: "Just now" },
  { id: 2, address: "0x5E6F...7A8B", style: "Fantasy Realism / Oil-paint",  priceRange: "0.1–0.5 ETH",   active: "1 hr ago" },
  { id: 3, address: "0x9C0D...1E2F", style: "Pixel Art / Chibi",            priceRange: "0.01–0.08 ETH", active: "3 hrs ago" },
  { id: 4, address: "0x3A4B...5C6D", style: "Watercolour / Soft Pastel",    priceRange: "0.08–0.3 ETH",  active: "5 hrs ago" },
]
const GUEST_LISTINGS = [
  { 
    id: 101, 
    style: "Cyberpunk / Cel shading",   
    price: "0.15", 
    aiTolerance: "0% — Human only", 
    revisions: 3, 
    postedAt: "2 hrs ago",
    description: "Only display the partial content of requirement description..." 
  },
  { 
    id: 102, 
    style: "Chibi / Watercolour",        
    price: "0.08", 
    aiTolerance: "0% — Human only", 
    revisions: 2, 
    postedAt: "5 hrs ago",
    description: "Only display the partial content of requirement description..." 
  },
  { 
    id: 103, 
    style: "Fantasy Realism",            
    price: "0.30", 
    aiTolerance: "Sketch only",      
    revisions: 5, 
    postedAt: "Just now",
    description: "Only display the partial content of requirement description..." 
  },
]

// ─────────────────────────────────────────────────────────────────────────────
function App() {

  const [account, setAccount]                 = useState(null) // default: null
  const [signer,  setSigner]                  = useState(null)
  const [activeTab, setActiveTab]             = useState("commission") // commission | creation | juror
  const [depositStatus, setDepositStatus]     = useState(null)         // null | "pass" | "insufficient"
  const [checkingDeposit, setCheckingDeposit] = useState(false)
  // Juror
  const [showJurorPopup, setShowJurorPopup]   = useState(false)
  const [pendingJurorCount, setPendingJurorCount] = useState(MOCK_JUROR_INVITATIONS)
  //Wallet
  const [walletBalance, setWalletBalance]     = useState(null)  // ETH in MetaMask
  const [contractDeposit, setContractDeposit] = useState(null)  // ETH in contract
  const [frozenBalance, setFrozenBalance]     = useState(null)  // ETH frozen in active orders
  const [depositAmount, setDepositAmount]     = useState("1.0") // user-editable
  const [withdrawAmount, setWithdrawAmount]   = useState("")    // user-editable
  const [walletTxStatus, setWalletTxStatus]   = useState("")

  // Auto-clear walletTxStatus after 5 seconds
  useEffect(() => {
    if (!walletTxStatus) return
    const t = setTimeout(() => setWalletTxStatus(""), 5000)
    return () => clearTimeout(t)
  }, [walletTxStatus])


  // ── Juror eligibility count ─────────────────────────────────────────────
  // Combines completed orders from BOTH roles for this wallet address.
  // Status 3 = "Completed" (Client approved) or "Payment Received" (Artist).
  // Status 5 (dispute-closed) does NOT count.
  //
  // MVP: uses MOCK_COMPLETED_COUNT so the demo works without a deployed contract.
  // Production: replace with fetchCompletedCount(signer) below.
  const [completedCount, setCompletedCount] = useState(MOCK_COMPLETED_COUNT)
  const isJurorEligible = completedCount >= 10

  useEffect(() => { checkIfWalletConnected() }, [])

  // Auto-fetch wallet info when account connects
  useEffect(() => {
    if (account && signer) fetchWalletInfo()
  }, [account, signer])

  // Show Juror invite popup once when eligible user connects
  useEffect(() => {
    if (account && isJurorEligible && pendingJurorCount > 0) {
      const t = setTimeout(() => setShowJurorPopup(true), 1200)
      return () => clearTimeout(t)
    }
  }, [account, isJurorEligible])

  const checkIfWalletConnected = async () => {
    if (!window.ethereum) return
    const accounts = await window.ethereum.request({ method: "eth_accounts" })
    if (accounts.length > 0) await setupProvider(accounts[0])
  }

  const connectWallet = async () => {
    if (!window.ethereum) { alert("Please connect MetaMask first."); return }
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" })
      await setupProvider(accounts[0])
    } catch (err) { console.error("Wallet connection rejected", err) }
  }

  const setupProvider = async (address) => {
    const provider = new ethers.BrowserProvider(window.ethereum)
    const signer   = await provider.getSigner()
    setAccount(address)
    setSigner(signer)
    await checkMandatoryDeposit(signer)
  }

  // ── MODULE 2: Fetch completed order count from both roles ───────────────
  // Call this after wallet connects. Reads live data from the contract.
  const fetchCompletedCount = async (signerObj) => {
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signerObj)
      const addr = await signerObj.getAddress()

      // Fetch all product IDs from both buyer and seller roles
      const [buyerIds, sellerIds] = await Promise.all([
        contract.getProductsByBuyer(addr),
        contract.getProductsBySeller(addr),
      ])

      // Fetch each product and count status-3 (Completed)
      let count = 0
      const allIds = [...new Set([...buyerIds.map(Number), ...sellerIds.map(Number)])]
      for (const id of allIds) {
        const p = await contract.getProduct(id)
        if (Number(p.status) === 3) count++
      }
      setCompletedCount(count)
    } catch (err) {
      // Contract not deployed yet : use mock value without blocking UI
      console.warn("fetchCompletedCount: using mock value", err.message)
    }
  }

  const disconnectWallet = () => {
    setAccount(null)
    setSigner(null)
    setDepositStatus(null)
    setActiveTab("commission")
    setCompletedCount(MOCK_COMPLETED_COUNT)
    setShowJurorPopup(false)
  }

  const checkMandatoryDeposit = async (signerObj) => {
    setCheckingDeposit(true)
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signerObj)
      const dep = await contract.depositBalance(await signerObj.getAddress())
      setDepositStatus(parseFloat(ethers.formatEther(dep)) >= 1.0 ? "pass" : "insufficient")
    } catch {
      // Contract not deployed yet, not block development
      setDepositStatus("pass")
    } finally { setCheckingDeposit(false) }
  }

  // ── Fetch MetaMask balance + contract deposit for wallet panel ──────────
  const fetchWalletInfo = async () => {
    try {
      const provider = new ethers.BrowserProvider(window.ethereum)
      const rawBal   = await provider.getBalance(account)
      setWalletBalance(parseFloat(ethers.formatEther(rawBal)).toFixed(4))
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      const [dep, frozen] = await Promise.all([
        contract.depositBalance(account),
        contract.frozenBalance(account),
      ])
      setContractDeposit(parseFloat(ethers.formatEther(dep)).toFixed(4))
      setFrozenBalance(parseFloat(ethers.formatEther(frozen)).toFixed(4))
    } catch (err) {
      console.warn("fetchWalletInfo failed", err.message)
    }
  }

  // ── Deposit any amount into contract ─────────────────────────────────────
  // Contract: deposit() external payable — adds to depositBalance[msg.sender]
  // Minimum to use the platform: 1 ETH (enforced on-chain by MIN_DEPOSIT)
  const DepositToContract = async () => {
    if (!depositAmount || parseFloat(depositAmount) <= 0) return
    setWalletTxStatus("⏳ Waiting for MetaMask confirmation...")
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      const tx = await contract.deposit({ value: ethers.parseEther(depositAmount) })
      setWalletTxStatus("⏳ Transaction submitted. Waiting for confirmation...")
      await tx.wait()
      await checkMandatoryDeposit(signer)  // re-check threshold
      await fetchWalletInfo()              // refresh panel numbers
      setWalletTxStatus(`✅ ${depositAmount} ETH deposited.`)
      setDepositAmount("1.0")
    } catch (err) {
      const msg = err.reason || err.shortMessage || err.message
      setWalletTxStatus(err.code === 4001 ? "Cancelled." : `❌ ${msg}`)
    }
  }

  // ── Withdraw any amount from contract deposit ─────────────────────────────
  // Contract: withdrawDeposit(uint256 amount) — fails if activeDisputeCount > 0
  const WithdrawDeposit = async () => {
    if (!withdrawAmount || parseFloat(withdrawAmount) <= 0) return
    setWalletTxStatus("⏳ Withdrawing...")
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      const tx = await contract.withdrawDeposit(ethers.parseEther(withdrawAmount))
      await tx.wait()
      await checkMandatoryDeposit(signer)
      await fetchWalletInfo()
      setWalletTxStatus(`✅ ${withdrawAmount} ETH withdrawn to your wallet!`)
      setWithdrawAmount("")
    } catch (err) {
      const msg = err.reason || err.shortMessage || err.message
      setWalletTxStatus(msg?.includes("active dispute")
        ? "⚠️ Cannot withdraw while you have an active dispute."
        : err.code === 4001 ? "Cancelled." : `❌ ${msg}`)
    }
  }

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div style={styles.app}>

      {/* ── Global header ── */}
      <header style={styles.header}>
        {/* Logo: clicking goes back to home / guest view */}
        <span style={{...styles.logo, cursor: 'pointer'}} onClick={disconnectWallet}>DeCommission</span>

        <div style={styles.headerRight}>
          {account ? (
            <div style={styles.headerInfo}>

              {/* Insufficient deposit warning */}
              {depositStatus === "insufficient" && (
                <span style={styles.depositWarn}>⚠ Insufficient Deposit</span>
              )}

              {/* Juror invite badge */}
              {isJurorEligible && pendingJurorCount > 0 && (
                <button
                  style={styles.jurorNotifBtn}
                  onClick={() => { setActiveTab("juror"); setShowJurorPopup(false) }}
                >
                  ⚖️ Juror
                  <span style={styles.notifDot}>{pendingJurorCount}</span>
                </button>
              )}

              {/* Wallet address tag */}
              <span style={styles.walletTag}>
                {account.slice(0, 6)}...{account.slice(-4)}
              </span>

              {/* Inline balance display */}
              <span style={styles.inlineBalance}>
                Wallet: {walletBalance !== null ? `${walletBalance}` : "—"} ETH
              </span>
              <span style={{
                ...styles.inlineBalance,
                color: contractDeposit !== null && parseFloat(contractDeposit) >= 1
                  ? "#a8f5d4" : "#f09595"
              }}>
                Deposit: {contractDeposit !== null ? `${contractDeposit}` : "—"} ETH
              </span>
              <span style={{
                ...styles.inlineBalance,
                color: "#ffc864"
              }}>
                🔒 Frozen: {frozenBalance !== null ? `${frozenBalance}` : "—"} ETH
              </span>

              {/* Inline deposit & withdraw */}
              <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <input
                  type="number"
                  min="0.01"
                  step="0.1"
                  value={depositAmount}
                  onChange={e => setDepositAmount(e.target.value)}
                  style={styles.inlineInput}
                  placeholder="ETH"
                />
                <button style={styles.walletActionBtn} onClick={DepositToContract}>
                  Deposit
                </button>
                <input
                  type="number"
                  min="0.01"
                  step="0.1"
                  value={withdrawAmount}
                  onChange={e => setWithdrawAmount(e.target.value)}
                  style={styles.inlineInput}
                  placeholder="ETH"
                />
                <button
                  style={{ ...styles.walletActionBtn, background: "rgba(240,149,149,0.15)", color: "#f09595", border: "1px solid rgba(240,149,149,0.3)" }}
                  onClick={WithdrawDeposit}
                >
                  Withdraw
                </button>
              </div>

              {walletTxStatus && (
                <span style={styles.inlineTxStatus}>{walletTxStatus}</span>
              )}

              {/* Quit / disconnect */}
              <button style={styles.quitBtn} onClick={disconnectWallet}>
                Quit
              </button>
            </div>
          ) : (
            <button style={styles.connectBtn} onClick={connectWallet}>
              🔗 Connect Wallet
            </button>
          )}
        </div>
      </header>

      {/* ── Insufficient deposit banner ── */}
      {account && depositStatus === "insufficient" && (
        <div style={styles.depositBanner}>
          <span>
            Mandatory deposit below 1 ETH. Platform functions are restricted.
          </span>
          <button style={styles.stakeBtn} onClick={() => { fetchWalletInfo() }}>
            Open Wallet →
          </button>
        </div>
      )}

      {/* ── Juror invitation popup ── */}
      {showJurorPopup && (
        <div style={styles.popupOverlay} onClick={() => setShowJurorPopup(false)}>
          <div style={styles.popup} onClick={e => e.stopPropagation()}>
            <div style={styles.popupIcon}>⚖️</div>
            <h3 style={styles.popupTitle}>Invitation to be a Juror</h3>
            <p style={styles.popupText}>
              You've been randomly selected to review{" "}
              <strong>{pendingJurorCount} dispute{pendingJurorCount > 1 ? "s" : ""}</strong>
              <br /><br />
              Each vote requires a certain amount of ETH participation stake.
              Majority voters earn a share of the penalty pool.
            </p>
            <div style={styles.popupActions}>
              <button
                style={styles.popupPrimary}
                onClick={() => { setActiveTab("juror"); setShowJurorPopup(false) }}
              >
                Review Now →
              </button>
              <button style={styles.popupGhost} onClick={() => setShowJurorPopup(false)}>
                Later
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          GUEST VIEW: wallet not connected
          
      ══════════════════════════════════════════════════════════════════════ */}
      {!account && <GuestPage onConnect={connectWallet} />}

      {/* ══════════════════════════════════════════════════════════════════════
          DASHBOARD: wallet connected
          Tab navigation + page content
      ══════════════════════════════════════════════════════════════════════ */}
      {account && (
        <div>
          {/* Dashboard tab bar */}
          <div style={styles.dashboardTabs}>
            <button
              style={activeTab === "commission" ? styles.dashTabActive : styles.dashTab}
              onClick={() => setActiveTab("commission")}
            >
              Commission
              <span style={styles.dashTabDesc}>Client Dashboard</span>
            </button>

            <button
              style={activeTab === "creation" ? styles.dashTabActive : styles.dashTab}
              onClick={() => setActiveTab("creation")}
            >
              Creation
              <span style={styles.dashTabDesc}>Artist Dashboard</span>
            </button>

            {/* Juror tab — always visible, shows locked state inside JurorPage */}
            <button
              style={{
                ...(activeTab === "juror" ? styles.dashTabActive : styles.dashTab),
                ...(!isJurorEligible && { opacity: 0.5 }),
              }}
              onClick={() => setActiveTab("juror")}
            >
              {isJurorEligible ? "⚖️ Juror" : "🔒 Juror"}
              <span style={styles.dashTabDesc}>
                {isJurorEligible ? `${pendingJurorCount} pending` : `${completedCount}/10 to unlock`}
              </span>
            </button>
          </div>

          {/* Dashboard content — all three pages stay mounted; CSS hides inactive ones */}
          <div style={styles.dashboardContent}>
            <div style={{display: activeTab === "commission" ? "block" : "none"}}>
              <ClientPage signer={signer} account={account} onTxComplete={fetchWalletInfo} contractDeposit={contractDeposit} />
            </div>
            <div style={{display: activeTab === "creation" ? "block" : "none"}}>
              <ArtistPage signer={signer} account={account} onTxComplete={fetchWalletInfo} />
            </div>
            <div style={{display: activeTab === "juror" ? "block" : "none"}}>
              <JurorPage
                signer={signer}
                account={account}
                completedCount={completedCount}
                onPendingCountChange={setPendingJurorCount}
                onTxComplete={fetchWalletInfo}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Guest Page ────────────────────────────────────────────────────────────────
// Read-only preview. Shows artists + open listings without any actions.
// Visitors can understand the platform before committing a wallet.
function GuestPage({ onConnect }) {
  const [guestTab, setGuestTab] = useState("artists") // artists | listings

  return (
    <div style={styles.guestPage}>

      {/* Home */}
      <div style={styles.home}>
        <h1 style={styles.homeTitle}>DeCommission</h1>
        <p style={styles.homeSub}>
          Decentralized Digital Art Commissioning Platform
          <br/>
          Decentralized Digital Art Commissioning Platform
          <br/>
          <br/>
          All funds are escrowed by smart contracts
          <br/>
          All disputes are adjudicated by the responsible community
          <br/>
          Funds are escrowed by smart contracts · Disputes are adjudicated by the community
        </p>
        
        <p style={styles.homeGuest}>Browse as a Guest ↓</p>
      </div>

      {/* Guest preview tabs */}
      <div style={styles.guestTabRow}>
        <button
          style={guestTab === "artists" ? styles.guestTabActive : styles.guestTab}
          onClick={() => setGuestTab("artists")}
        >
          See Our Artists
        </button>
        <button
          style={guestTab === "listings" ? styles.guestTabActive : styles.guestTab}
          onClick={() => setGuestTab("listings")}
        >
          See Our Open Commissions
        </button>
      </div>

      {/* Artist cards */}
      {guestTab === "artists" && (
        <div style={styles.guestGrid}>
          {GUEST_ARTISTS.map(a => (
            <div key={a.id} style={styles.guestCard}>
              <div style={styles.guestAddr}>{a.address}</div>
              <span style={styles.activeTag}>● {a.active}</span>
              <p style={styles.guestStyle}>{a.style}</p>
              <div style={styles.guestPrice}>{a.priceRange}</div>
              {/* Locked action */}
              <button style={styles.lockedBtn} onClick={onConnect}>
                🔗 Connect to Commission →
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Open listing cards */}
      {guestTab === "listings" && (
        <div style={styles.guestListings}>
          {GUEST_LISTINGS.map(l => (
            <div key={l.id} style={styles.guestCard}>
              <div style={styles.guestCardHeader}>
                <div>
                  <div style={styles.guestStyle}>{l.style}</div>
                  <div style={styles.guestTagRow}>
                    <span style={styles.pill}>🤖 AI: {l.aiTolerance}</span>
                    <span style={styles.pill}>✏️ Revisions: {l.revisions}</span>
                    <span style={styles.pill}>🕐 {l.postedAt}</span>
                  </div>
                </div>
                <div style={styles.guestPrice}>{l.price} ETH</div>
              </div>

              <div style={styles.guestDesc}>
                {l.description}
              </div>

              {/* Locked action */}
              <button style={styles.lockedBtn} onClick={onConnect}>
                🔗 Connect to Accept →
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Bottom */}
      <div style={styles.guestCta}>
        <p style={styles.guestCtaText}>
          Ready to participate? Connect your wallet to post commissions,
          accept orders, or join the Juror panel.
        </p>
        <button style={styles.homeBtn} onClick={onConnect}>
          🔗 Wallet MetaMask to Start Your Art Journey
        </button>
      </div>
    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const styles = {
  app: { minHeight: "100vh", background: "#0d0d0f", color: "#e8e6de", fontFamily: "'DM Sans', 'Noto Sans SC', sans-serif" },

  // Header
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 40px", borderBottom: "1px solid rgba(255,255,255,0.07)", background: "rgba(13,13,15,0.95)", position: "sticky", top: 0, zIndex: 100 },
  logo: { color: "#a8f5d4", fontSize: "20px", fontWeight: "700", letterSpacing: "0.06em" },
  headerRight: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" },
  headerInfo: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" },
  // Wallet
  walletTag: { padding: "6px 14px", background: "rgba(168,245,212,0.08)", border: "1px solid rgba(168,245,212,0.2)", borderRadius: "20px", fontSize: "12px", color: "#a8f5d4", fontFamily: "monospace" },
  inlineBalance: { fontSize: "12px", color: "#e8e6de", fontFamily: "monospace", padding: "4px 10px", background: "rgba(255,255,255,0.04)", borderRadius: "8px", whiteSpace: "nowrap" },
  inlineAction: { display: "flex", gap: "4px", alignItems: "center" },
  inlineInput: { width: "60px", padding: "5px 8px", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "6px", color: "#fff", fontSize: "12px" },
  inlineTxStatus: { fontSize: "11px", color: "#a8f5d4", padding: "4px 8px", background: "rgba(168,245,212,0.06)", borderRadius: "6px", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },

  walletActionBtn: { padding: "7px 12px", background: "rgba(168,245,212,0.15)", border: "1px solid rgba(168,245,212,0.3)", borderRadius: "6px", color: "#a8f5d4", fontSize: "12px", fontWeight: "700", cursor: "pointer", whiteSpace: "nowrap" },
  
  quitBtn: { padding: "6px 14px", background: "rgba(255,80,80,0.12)", border: "1px solid rgba(255,80,80,0.35)", borderRadius: "20px", fontSize: "12px", color: "#ff6b6b", cursor: "pointer" },
  depositWarn: { fontSize: "12px", color: "#f09595", padding: "4px 10px", background: "rgba(240,149,149,0.1)", border: "1px solid rgba(240,149,149,0.2)", borderRadius: "10px" },
  connectBtn: { padding: "8px 20px", background: "#a8f5d4", color: "#0d0d0f", border: "none", borderRadius: "20px", fontSize: "13px", fontWeight: "700", cursor: "pointer" },
  jurorNotifBtn: { display: "flex", alignItems: "center", gap: "6px", padding: "6px 14px", background: "rgba(226,75,74,0.1)", border: "1px solid rgba(226,75,74,0.25)", borderRadius: "20px", color: "#f09595", fontSize: "12px", fontWeight: "600", cursor: "pointer" },
  notifDot: { background: "#E24B4A", color: "#fff", borderRadius: "10px", padding: "1px 6px", fontSize: "11px", fontWeight: "700" },

  // Deposit banner
  depositBanner: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 40px", background: "rgba(240,149,149,0.07)", borderBottom: "1px solid rgba(240,149,149,0.15)", fontSize: "13px", color: "#f09595" },
  stakeBtn: { padding: "7px 18px", background: "#f09595", color: "#0d0d0f", border: "none", borderRadius: "8px", fontSize: "13px", fontWeight: "700", cursor: "pointer", whiteSpace: "nowrap", marginLeft: "16px" },

  // Popup 
  popupOverlay: { 
    position: "fixed", 
    top: 0, 
    left: 0, 
    width: "100vw", 
    height: "100vh", 
    display: "flex", 
    justifyContent: "center", 
    alignItems: "center", 
    background: "rgba(0,0,0,0.75)", 
    zIndex: 999, // float on the top
  },
  popup: { background: "#181818", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "18px", padding: "36px 32px", maxWidth: "380px", width: "100%", textAlign: "center" },
  popupIcon: { fontSize: "36px", marginBottom: "12px" },
  popupTitle: { fontSize: "18px", fontWeight: "600", color: "#fff", marginBottom: "12px" },
  popupText: { fontSize: "14px", color: "#888", lineHeight: "1.7", marginBottom: "24px" },
  popupActions: { display: "flex", gap: "10px" },
  popupPrimary: { flex: 1, padding: "12px", background: "#a8f5d4", color: "#0d0d0f", border: "none", borderRadius: "8px", fontSize: "14px", fontWeight: "700", cursor: "pointer" },
  popupGhost: { padding: "12px 20px", background: "transparent", color: "#666", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "8px", fontSize: "14px", cursor: "pointer" },

  // Dashboard tabs
  dashboardTabs: { display: "flex", gap: "2px", padding: "0 40px", background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.06)" },
  dashTab: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "2px", padding: "16px 24px", background: "transparent", border: "none", borderBottom: "2px solid transparent", color: "#555", cursor: "pointer", fontSize: "14px", fontWeight: "600" },
  dashTabActive: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "2px", padding: "16px 24px", background: "transparent", border: "none", borderBottom: "2px solid #a8f5d4", color: "#a8f5d4", cursor: "pointer", fontSize: "16px", fontWeight: "600" },
  dashTabDesc: { fontSize: "11px", color: "#555", fontWeight: "400" },
  dashboardContent: { minHeight: "calc(100vh - 120px)" },

  // Guest page
  guestPage: { maxWidth: "900px", margin: "0 auto", padding: "0 40px 80px" },
  home: { textAlign: "center", padding: "80px 0 48px" },
  homeTitle: { fontSize: "48px", fontWeight: "700", color: "#fff", marginBottom: "16px", letterSpacing: "0.02em" },
  homeSub: { fontSize: "16px", color: "rgba(232,230,222,0.45)", lineHeight: "1.8", marginBottom: "36px" },
  homeBtn: { padding: "15px 40px", background: "#a8f5d4", color: "#0d0d0f", border: "none", borderRadius: "12px", fontSize: "15px", fontWeight: "700", cursor: "pointer" },
  
  homeGuest: { padding: "15px 40px", marginTop: "16px", fontSize: "15px", color: "#555" },
  guestTabRow: { display: "flex", gap: "8px", marginBottom: "20px", borderBottom: "1px solid rgba(255,255,255,0.07)", paddingBottom: "12px" },
  guestTab: { padding: "8px 20px", background: "transparent", color: "#555", border: "none", cursor: "pointer", fontSize: "14px", fontWeight: "600", borderRadius: "8px" },
  guestTabActive: { padding: "8px 20px", background: "rgba(168,245,212,0.08)", color: "#a8f5d4", border: "none", cursor: "pointer", fontSize: "16px", fontWeight: "600", borderRadius: "8px" },
  guestGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "40px" },
  guestListings: { display: "flex", flexDirection: "column", gap: "12px", marginBottom: "40px" },
  guestCard: { background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "12px", padding: "18px" },
  guestCardHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" },
  guestAddr: { fontSize: "13px", fontFamily: "monospace", color: "#fff", marginBottom: "4px" },
  activeTag: { fontSize: "11px", color: "#a8f5d4", background: "rgba(168,245,212,0.07)", padding: "2px 8px", borderRadius: "4px", display: "inline-block", marginBottom: "8px" },
  guestStyle: { fontSize: "14px", color: "#ccc", marginBottom: "8px" },
  guestTagRow: { display: "flex", gap: "6px", flexWrap: "wrap" },
  guestPrice: { fontSize: "16px", fontWeight: "700", color: "#a8f5d4" },
  
  guestDesc: { 
    fontSize: "13px", 
    color: "rgba(232,230,222,0.6)", 
    lineHeight: "1.6",              
    marginTop: "12px",              
    marginBottom: "16px",          
  },
  lockedBtn: { width: "100%", marginTop: "12px", padding: "9px", background: "transparent", border: "1px dashed rgba(168,245,212,0.2)", borderRadius: "8px", color: "#a8f5d4", fontSize: "12px", cursor: "pointer" },
  pill: { fontSize: "11px", color: "rgba(232,230,222,0.5)", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "20px", padding: "3px 9px" },
  guestCta: { textAlign: "center", padding: "48px 0 0" },
  guestCtaText: { fontSize: "14px", color: "#555", lineHeight: "1.7", marginBottom: "20px" },
}

export default App
