/**
 * ArtistPage.jsx — Artist (Seller) Interface
 *
 * ─────────────────────────────────────────────────────────────
 * MODULE 1 · MOCK DATA (pure frontend, no contract needed)
 * ─────────────────────────────────────────────────────────────
 *  - MOCK_LISTINGS       : hardcoded open listings for 
 *                          keeping Browse tab filled during the demo
 *  - MOCK_HISTORY_ORDERS : pre-filled completed orders 
 *                          
 *  - fakeCID generation  : setTimeout simulates IPFS upload for
 *                          watermarked delivery without real upload
 *  - [Demo] status 0→1   : "Start Working" button 
 *                          — no contract call needed; just a local state update
 *
 * ─────────────────────────────────────────────────────────────
 * MODULE 2 · REAL CONTRACT CALLS (ethers.js → MetaMask → chain)
 * ─────────────────────────────────────────────────────────────
 *  - fetchMyOrders()    : reads Artist's live orders from chain
 *  - acceptOrder()      : contract.acceptOrder(listingId)
 *  - deliverOrder()     : contract.submitDelivery(orderId, cid)
 *                         fake CID is fine for MVP demo
 *  - raiseDispute()     : contract.raiseDispute(orderId)
 */

import { useState, useEffect } from "react"
import { ethers } from "ethers"
import { CONTRACT_ADDRESS, CONTRACT_ABI } from "../contract/config.js"

// ─── MODULE 1: Mock open listings ─────────────────────────────────────────────
// Hardcoded. Browser tab is filled with orders to present a mature platform.
// In production these come from contract.getActiveListings() + IPFS detail fetch.
const MOCK_LISTINGS = [
  {
    id: 101,
    clientAddr: "0xAABB...1234",
    description: "Urgent — Cyberpunk OC half-body portrait. Strong neon contrast, mechanical prosthetics. Need sketch + colour confirmation stages. Strictly no AI generation.",
    style: "Cyberpunk / Cel shading",
    aiTolerance: "0% — Human only",
    revisions: 3,
    deadline: "2026-05-10",
    price: "0.15",
    postedAt: "2 hours ago",
    cid: "QmFakeABC123",
  },
  {
    id: 102,
    clientAddr: "0xCCDD...5678",
    description: "Chibi cat illustration for VTuber debut. Need front + back line art and final colour version. Soft watercolour style.",
    style: "Chibi Style/ Watercolour",
    aiTolerance: "0% — Human only",
    revisions: 2,
    deadline: "2026-04-22",
    price: "0.08",
    postedAt: "5 hours ago",
    cid: "QmFakeDEF456",
  },
  {
    id: 103,
    clientAddr: "0xEEFF...9012",
    description: "DnD wizard character, half-body, dynamic spellcasting pose. Realism-leaning. AI allowed for rough sketch only; final linework and colour must be hand-drawn.",
    style: "Fantasy Realism / Semi-painterly",
    aiTolerance: "Sketch stage only",
    revisions: 5,
    deadline: "",
    price: "0.30",
    postedAt: "Just now",
    cid: "QmFakeGHI789",
  },
]

const formatDeadline = (dateStr) => {
  if (!dateStr) return "Flexible"
  const days = Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24))
  if (days < 0)  return "Overdue"
  if (days === 0) return "Today"
  if (days === 1) return "Tomorrow"
  if (days <= 7)  return `${days} days`
  if (days <= 30) return `${Math.ceil(days / 7)} weeks`
  return `${Math.ceil(days / 30)} months`
}

// ─── MODULE 1: Mock history orders ────────────────────────────────────────────
// Shows Juror eligibility counter without needing 10 real transactions.
const MOCK_HISTORY_ORDERS = [
  { id: 8001, clientAddr: "0x1111...AAAA", amount: "0.10", status: 3, deliveryCid: "QmDelMock001" },
  { id: 8002, clientAddr: "0x2222...BBBB", amount: "0.20", status: 3, deliveryCid: "QmDelMock002" },
  { id: 8003, clientAddr: "0x3333...CCCC", amount: "0.15", status: 5, deliveryCid: "QmDelMock003" }, // dispute
]

// ─── Status labels: Artist perspective ────────────────────────────────────────
const ARTIST_STATUS = {
  0: "New Order",        // just accepted, not yet started
  1: "In Progress",      // actively working
  2: "Delivered",        // watermarked work submitted, awaiting Client
  3: "Payment Received", // Client approved, funds released
  4: "In Dispute",       // dispute raised by either party
  5: "Closed",           // dispute resolved and archived
}

// ─────────────────────────────────────────────────────────────────────────────
export default function ArtistPage({ signer, account }) {

  const [activeTab, setActiveTab] = useState("browse")  // browse | ongoing | history
  const [loading, setLoading]     = useState(false)
  const [txStatus, setTxStatus]   = useState("")
  const [expandedId, setExpandedId] = useState(null)

  const [listings, setListings]   = useState([])   // open listings on the platform
  const [myOrders, setMyOrders]   = useState([])   // Artist's own active orders

  // ── MODULE 2: Load on mount ──────────────────────────────────────────────
  useEffect(() => {
    // MODULE 1: always show mock listings regardless of wallet
    setListings(MOCK_LISTINGS)
    // MODULE 2: load live orders if wallet is connected
    if (signer) fetchMyOrders()
  }, [signer])

  const fetchMyOrders = async () => {
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      // ⚠ 对应后端修改 Align with actual contract: getOrdersByArtist(account) or similar
      const raw = await contract.getOrdersByArtist(account)
      setMyOrders(raw.map(o => ({
        id:          Number(o.id),
        clientAddr:  o.client,
        amount:      ethers.formatEther(o.price),
        status:      Number(o.state),
        cid:         o.ipfsHash,
        deliveryCid: o.deliveryCid || null,
      })))
    } catch (err) {
      console.warn("fetchMyOrders: contract not ready or ABI mismatch", err.message)
    }
  }

  // ── MODULE 2: Accept order ───────────────────────────────────────────────
  const acceptOrder = async (listing) => {
    if (!signer) { alert("Please connect your wallet first."); return }
    setLoading(true)
    setTxStatus("⏳ Waiting for MetaMask confirmation...")
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      // acceptOrder(uint256 orderId) — no ETH needed; Artist simply commits
      const tx = await contract.acceptOrder(listing.id)
      setTxStatus("⏳ Transaction submitted. Waiting for block confirmation...")
      await tx.wait()

      // Add to local order list immediately
      setMyOrders(prev => [...prev, {
        id:          listing.id,
        clientAddr:  listing.clientAddr,
        description: listing.description,
        amount:      listing.price,
        cid:         listing.cid,
        deliveryCid: null,
        status:      0, // New Order
      }])
      setListings(prev => prev.filter(l => l.id !== listing.id))
      setTxStatus("✅ Order accepted and recorded on-chain.")
      setActiveTab("ongoing")
    } catch (err) {
      setTxStatus(err.code === 4001 ? "Cancelled." : `❌ ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // ── MODULE 2: Submit delivery ────────────────────────────────────────────
  const deliverOrder = async (orderId) => {
    setLoading(true)

    // MODULE 1: Simulate IPFS upload
    setTxStatus("⏳ Uploading watermarked work to IPFS (simulated)...")
    await new Promise(r => setTimeout(r, 1500))
    const fakeCID = "QmDeliver" + Math.random().toString(36).substring(2, 8).toUpperCase()

    // MODULE 2: Real contract call
    setTxStatus("⏳ Submitting delivery CID on-chain...")
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      // submitDelivery(uint256 orderId, string memory deliveryCid)
      const tx = await contract.submitDelivery(orderId, fakeCID)
      await tx.wait()
      setMyOrders(prev =>
        prev.map(o => o.id === orderId ? { ...o, status: 2, deliveryCid: fakeCID } : o)
      )
      setTxStatus(`✅ Successful Delivery! CID: ${fakeCID}`)
    } catch (err) {
      setTxStatus(err.code === 4001 ? "Cancelled." : `❌ ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // ── MODULE 2: Raise dispute ──────────────────────────────────────────────
  const raiseDispute = async (orderId) => {
    setLoading(true)
    setTxStatus("⏳ Raising dispute — MetaMask will prompt for the arbitration deposit...")
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      // ⚠ 对应后端修改 Confirm exact function signature and deposit amount with backend team
      const tx = await contract.raiseDispute(orderId)
      await tx.wait()
      setMyOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: 4 } : o))
      setTxStatus("⚠️ Dispute raised. Funds frozen. Waiting for Juror votes...")
    } catch (err) {
      setTxStatus(err.code === 4001 ? "Cancelled." : `❌ ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // ── Derived lists ────────────────────────────────────────────────────────
  const allOrders     = [...myOrders, ...MOCK_HISTORY_ORDERS]
  const ongoingOrders = allOrders.filter(o => [0, 1, 2, 4].includes(o.status))
  const historyOrders = allOrders.filter(o => [3, 5].includes(o.status))

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER FUNCTIONS
  // ─────────────────────────────────────────────────────────────────────────

  const renderBrowse = () => (
    <div>
      {listings.length === 0
        ? <div style={styles.empty}>No open listings right now.</div>
        : listings.map(listing => (
          <div key={listing.id} style={styles.card}>
            <div style={styles.cardHeader}>
              <div>
                <div style={styles.metaRow}>
                  <span style={styles.clientAddr}>{listing.clientAddr}</span>
                  <span style={styles.postedTag}>{listing.postedAt}</span>
                </div>
                <p style={styles.descText}>
                  {expandedId === listing.id
                    ? listing.description
                    : listing.description.substring(0, 90) + "..."}
                </p>
              </div>
              <div style={styles.priceTag}>{listing.price} ETH</div>
            </div>

            <div style={styles.tagRow}>
              <span style={styles.pill}>🎨 {listing.style}</span>
              <span style={styles.pill}>🤖 AI: {listing.aiTolerance}</span>
              <span style={styles.pill}>✏️ Revisions: {listing.revisions}</span>
              <span style={styles.pill}>📅 Deadline: {formatDeadline(listing.deadline)}</span>
            </div>

            <div style={styles.actionRow}>
              <button
                style={styles.ghostBtn}
                onClick={() => setExpandedId(expandedId === listing.id ? null : listing.id)}
              >
                {expandedId === listing.id ? "Collapse ↑" : "View Details ↓"}
              </button>
              <button
                style={styles.primaryBtn}
                onClick={() => acceptOrder(listing)}
                disabled={loading}
              >
                {loading ? "Processing..." : `Accept Order (${listing.price} ETH) →`}
              </button>
            </div>

            {expandedId === listing.id && (
              <div style={styles.expandBox}>
                <div style={styles.cidText}>📦 Requirements CID: {listing.cid}</div>
                <p style={styles.expandNote}>
                  In production, this CID resolves to the full JSON requirements
                  (description, references, canvas specs etc.) stored on IPFS.
                </p>
              </div>
            )}
          </div>
        ))
      }
    </div>
  )

  const renderOngoing = () => (
    <div>
      {ongoingOrders.length === 0
        ? <div style={styles.empty}>No ongoing orders. Browse listings to accept one!</div>
        : ongoingOrders.map(order => (
          <div key={order.id} style={styles.card}>
            <div style={styles.cardHeader}>
              <div>
                <div style={styles.metaRow}>
                  <span style={styles.orderId}>Order #{order.id}</span>
                  <span style={order.status === 4 ? styles.disputeTag : styles.ongoingTag}>
                    {ARTIST_STATUS[order.status]}
                  </span>
                </div>
                <span style={styles.clientAddr}>Client: {order.clientAddr}</span>
              </div>
              <div style={styles.priceTag}>{order.amount} ETH</div>
            </div>

            <div style={styles.cidText}>Requirements CID: {order.cid}</div>

            {/* Status 0: New Order (No on-chain call needed) */}
            {order.status === 0 && (
              <div style={styles.actionBox}>
                <p style={styles.hintText}>
                  Order confirmed on-chain. Please start working. No transacted funds happen until delivery.
                </p>
                {/* MODULE 1: local state update only, no contract call */}
                <button
                  style={styles.magicBtn}
                  onClick={() =>
                    setMyOrders(prev =>
                      prev.map(o => o.id === order.id ? { ...o, status: 1 } : o)
                    )
                  }
                >
                  ✨ [Demo] Mark as In Progress (local state only)
                </button>
              </div>
            )}

            {/* Status 1: In Progress (Submit watermarked delivery) */}
            {order.status === 1 && (
              <div style={styles.actionBox}>
                <p style={styles.hintText}>
                  Ready to deliver? Upload your watermarked work! the CID needs to be submitted on-chain.
                </p>
                <button
                  style={styles.deliverBtn}
                  onClick={() => deliverOrder(order.id)}
                  disabled={loading}
                >
                  {loading ? "Uploading..." : "📤 Submit Delivery (Upload to IPFS)"}
                </button>
              </div>
            )}

            {/* Status 2: Delivered (waiting for Client; can raise dispute) */}
            {order.status === 2 && (
              <div style={styles.actionBox}>
                <p style={styles.hintText}>
                  Work delivered. Waiting for Client to approve.
                  <br />
                  <span style={{ color: "#555", fontSize: "11px" }}>
                    Delivery CID: {order.deliveryCid}
                  </span>
                </p>
                <button
                  style={styles.dangerBtn}
                  onClick={() => raiseDispute(order.id)}
                  disabled={loading}
                >
                  Raise Dispute
                </button>
              </div>
            )}

            {/* Status 4: In Dispute */}
            {order.status === 4 && (
              <div style={styles.actionBox}>
                <p style={{ fontSize: "13px", color: "#ff8b8b" }}>
                  Dispute in progress. Jurors are reviewing the evidence. Please wait.
                </p>
              </div>
            )}
          </div>
        ))
      }
    </div>
  )

  const renderHistory = () => (
    <div>
      {historyOrders.length === 0
        ? <div style={styles.empty}>No completed orders yet.</div>
        : historyOrders.map(order => (
          <div key={order.id} style={{ ...styles.card, opacity: 0.75 }}>
            <div style={styles.cardHeader}>
              <div>
                <div style={styles.metaRow}>
                  <span style={styles.orderId}>Order #{order.id}</span>
                  <span style={order.status === 3 ? styles.completedTag : styles.closedTag}>
                    {ARTIST_STATUS[order.status]}
                  </span>
                </div>
                <span style={styles.clientAddr}>Client: {order.clientAddr}</span>
              </div>
              <div style={styles.priceTag}>{order.amount} ETH</div>
            </div>
            {order.deliveryCid && (
              <div style={styles.cidText}>Delivery CID: {order.deliveryCid}</div>
            )}
            {order.status === 3 && (
              <p style={styles.reputationNote}>
                🎉 Payment received.
              </p>
            )}
            {order.status === 5 && (
              <p style={{ ...styles.reputationNote, color: "#888" }}>
                ⚖️ Closed after dispute resolution.
              </p>
            )}
          </div>
        ))
      }
    </div>
  )

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <div style={styles.page}>
      <div style={styles.tabContainer}>
        <button
          style={activeTab === "browse" ? styles.activeTab : styles.tab}
          onClick={() => setActiveTab("browse")}
        >
          Browse Listings
          {listings.length > 0 && <span style={styles.badge}>{listings.length}</span>}
        </button>
        <button
          style={activeTab === "ongoing" ? styles.activeTab : styles.tab}
          onClick={() => setActiveTab("ongoing")}
        >
          Ongoing
          {ongoingOrders.length > 0 && <span style={styles.badge}>{ongoingOrders.length}</span>}
        </button>
        <button
          style={activeTab === "history" ? styles.activeTab : styles.tab}
          onClick={() => setActiveTab("history")}
        >
          History
        </button>
      </div>

      {txStatus && <div style={styles.statusBar}>{txStatus}</div>}

      <div style={styles.content}>
        {activeTab === "browse"  && renderBrowse()}
        {activeTab === "ongoing" && renderOngoing()}
        {activeTab === "history" && renderHistory()}
      </div>
    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const styles = {
  page: { padding: "32px 40px", maxWidth: "900px", margin: "0 auto" },
  tabContainer: { display: "flex", gap: "8px", marginBottom: "24px", borderBottom: "1px solid rgba(255,255,255,0.08)", paddingBottom: "12px", alignItems: "center" },
  tab: { display: "flex", alignItems: "center", gap: "6px", padding: "10px 20px", background: "transparent", color: "#666", border: "none", cursor: "pointer", fontSize: "15px", fontWeight: "600", borderRadius: "8px" },
  activeTab: { display: "flex", alignItems: "center", gap: "6px", padding: "10px 20px", background: "rgba(168,245,212,0.1)", color: "#a8f5d4", border: "none", cursor: "pointer", fontSize: "15px", fontWeight: "600", borderRadius: "8px" },
  badge: { background: "#a8f5d4", color: "#0d0d0f", borderRadius: "10px", padding: "1px 7px", fontSize: "11px", fontWeight: "700" },
  statusBar: { padding: "12px 18px", background: "rgba(168,245,212,0.07)", border: "1px solid rgba(168,245,212,0.2)", borderRadius: "10px", marginBottom: "20px", fontSize: "13px", color: "#a8f5d4" },
  content: { marginTop: "4px" },
  
  
  card: { background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "12px", padding: "20px", marginBottom: "14px" },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px", gap: "12px" },
  metaRow: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" },
  clientAddr: { fontSize: "12px", color: "rgba(232,230,222,0.35)", fontFamily: "monospace" },
  postedTag: { fontSize: "11px", color: "#666", background: "rgba(255,255,255,0.05)", padding: "2px 8px", borderRadius: "4px" },
  orderId: { fontSize: "12px", color: "rgba(232,230,222,0.35)", fontFamily: "monospace" },
  descText: { fontSize: "14px", color: "#ccc", lineHeight: "1.6", margin: "4px 0" },
  priceTag: { fontSize: "20px", fontWeight: "700", color: "#a8f5d4", whiteSpace: "nowrap" },
  cidText: { fontSize: "11px", color: "#555", fontFamily: "monospace", marginTop: "4px" },
  tagRow: { display: "flex", gap: "8px", flexWrap: "wrap", margin: "10px 0 14px" },
  pill: { fontSize: "12px", color: "rgba(232,230,222,0.55)", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "20px", padding: "4px 10px" },
  actionRow: { display: "flex", gap: "10px", alignItems: "center" },
  actionBox: { marginTop: "12px", padding: "14px", background: "rgba(255,255,255,0.03)", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.06)" },
  hintText: { fontSize: "13px", color: "#888", marginBottom: "10px", lineHeight: "1.6" },
  expandBox: { marginTop: "12px", padding: "12px", background: "rgba(168,245,212,0.04)", borderRadius: "8px", border: "1px solid rgba(168,245,212,0.1)" },
  expandNote: { fontSize: "12px", color: "#666", marginTop: "6px", lineHeight: "1.5" },
  reputationNote: { fontSize: "12px", color: "#a8f5d4", marginTop: "8px" },
  
  // 
  
  primaryBtn: { padding: "10px 20px", background: "#a8f5d4", color: "#0d0d0f", border: "none", borderRadius: "8px", fontSize: "13px", fontWeight: "700", cursor: "pointer", whiteSpace: "nowrap" },
  ghostBtn: { padding: "10px 16px", background: "transparent", color: "rgba(232,230,222,0.5)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", fontSize: "13px", cursor: "pointer" },
  deliverBtn: { width: "100%", padding: "12px", background: "rgba(168,245,212,0.1)", border: "1px solid rgba(168,245,212,0.3)", borderRadius: "8px", color: "#a8f5d4", fontSize: "13px", fontWeight: "700", cursor: "pointer" },
  dangerBtn: { width: "100%", padding: "10px", background: "transparent", border: "1px solid rgba(255,139,139,0.35)", borderRadius: "8px", color: "#ff8b8b", fontSize: "13px", cursor: "pointer" },
  magicBtn: { width: "100%", padding: "9px", background: "rgba(255,255,255,0.03)", border: "1px dashed rgba(255,255,255,0.12)", borderRadius: "8px", color: "#666", cursor: "pointer", fontSize: "12px", marginTop: "8px" },
  
  // Tags
  ongoingTag: { fontSize: "12px", color: "#a8f5d4", background: "rgba(168,245,212,0.1)", padding: "3px 8px", borderRadius: "6px" },
  disputeTag: { fontSize: "12px", color: "#ff8b8b", background: "rgba(255,139,139,0.1)", padding: "3px 8px", borderRadius: "6px" },
  completedTag: { fontSize: "12px", color: "#a8f5d4", border: "1px solid rgba(168,245,212,0.4)", padding: "3px 8px", borderRadius: "6px" },
  closedTag: { fontSize: "12px", color: "#666", border: "1px solid rgba(255,255,255,0.1)", padding: "3px 8px", borderRadius: "6px" },
  empty: { color: "#555", fontStyle: "italic", textAlign: "center", padding: "40px 0", fontSize: "14px" },
}
