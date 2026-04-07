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
 *  - fetchListings()    : reads open commissions from chain
 *  - fetchMyOrders()    : reads Artist's accepted orders from chain
 *  - acceptOrder()      : contract.acceptCommission(productId)
 *  - deliverOrder()     : contract.confirmShipment(productId, cid)
 *                         fake CID is fine for MVP demo
 *  - raiseDispute()     : contract.raiseDispute(productId)
 */

import { useState, useEffect } from "react"
import { ethers } from "ethers"
import { CONTRACT_ADDRESS, CONTRACT_ABI } from "../contract/config.js"
import { uploadDelivery, ipfsGatewayUrl } from "../utils/pinata.js"

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



// ─── Status labels: Artist perspective ────────────────────────────────────────
const ARTIST_STATUS = {
  1: "In Progress",      // accepted, working on it
  2: "Delivered",        // watermarked work submitted, awaiting Client
  3: "Payment Received", // Client approved, funds released
  4: "In Dispute",       // dispute raised by either party
  5: "Closed",           // dispute resolved and archived
}

// ─────────────────────────────────────────────────────────────────────────────
export default function ArtistPage({ signer, account, onTxComplete }) {

  const [activeTab, setActiveTab] = useState("browse")  // browse | ongoing | history
  const [loading, setLoading]     = useState(false)
  const [txStatus, setTxStatus]   = useState("")
  const [expandedId, setExpandedId] = useState(null)

  const [listings, setListings]     = useState([])   // open listings on the platform
  const [myOrders, setMyOrders]     = useState([])   // Artist's own active orders
  const [deliveryFiles, setDeliveryFiles] = useState({})  // orderId -> File for IPFS upload
  // cid -> fetched requirements object | "loading" | "error"
  const [requirementsMeta, setRequirementsMeta] = useState({})

  // ── MODULE 2: Load on mount ──────────────────────────────────────────────
  useEffect(() => {
    if (signer) {
      fetchListings()
      fetchMyOrders()
    } else {
      // No wallet: show mock listings for demo
      setListings(MOCK_LISTINGS)
    }
  }, [signer])

  // ── MODULE 2: Auto-refresh order status ─────
  // Covers all state transitions so UI auto-updates without manual refresh.
  // Listen to backend contracts' events. Event names match.  
  useEffect(() => {
    if (!signer) return
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
    const refresh = () => fetchMyOrders()

    contract.on("CommissionAccepted", refresh)  // 0→1: Artist accepted
    contract.on("ProductShipped",     refresh)  // 1→2: Artist delivered
    contract.on("ProductCompleted",   refresh)  // 2→3: Client approved
    contract.on("ProductDisputed",    refresh)  // 2→4: Dispute raised
    contract.on("DisputeResolved",    refresh)  // 4→5: Dispute settled

    return () => {
      contract.off("CommissionAccepted", refresh)
      contract.off("ProductShipped",     refresh)
      contract.off("ProductCompleted",   refresh)
      contract.off("ProductDisputed",    refresh)
      contract.off("DisputeResolved",    refresh)
    }
  }, [signer])

  const fetchListings = async () => {
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      const ids = await contract.getListedProducts()
      const results = []
      for (const id of ids) {
        const p = await contract.getProduct(id)
        results.push({
          id:          Number(p.id),
          clientAddr:  p.buyer.slice(0, 6) + "..." + p.buyer.slice(-4),
          clientFull:  p.buyer,
          description: `Commission #${Number(p.id)} — view IPFS CID for full requirements`,
          style:       "",
          aiTolerance: "",
          revisions:   "",
          deadline:    "",
          price:       ethers.formatEther(p.price),
          postedAt:    new Date(Number(p.listedAt) * 1000).toLocaleString(),
          cid:         p.ipfsHash,
        })
      }
      // Show real data from chain (empty list is fine when wallet connected)
      setListings(results)
    } catch (err) {
      console.warn("fetchListings: contract not ready", err.message)
      setListings(MOCK_LISTINGS)
    }
  }

  const fetchMyOrders = async () => {
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      const ids = await contract.getProductsBySeller(account)
      const orders = []
      for (const id of ids) {
        const p = await contract.getProduct(id)
        orders.push({
          id:          Number(p.id),
          clientAddr:  p.buyer.slice(0, 6) + "..." + p.buyer.slice(-4),
          amount:      ethers.formatEther(p.price),
          status:      Number(p.status),
          cid:         p.ipfsHash,
          deliveryCid: p.deliveryIpfsHash || null,
        })
      }
      setMyOrders(orders)
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
      // acceptCommission(uint256 productId) — no ETH needed; Artist simply commits
      const tx = await contract.acceptCommission(listing.id)
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
        status:      1, // Sold = In Progress from artist perspective
      }])
      setListings(prev => prev.filter(l => l.id !== listing.id))
      setTxStatus("✅ Commission accepted and recorded on-chain.")
      setActiveTab("ongoing")
    } catch (err) {
      setTxStatus(err.code === 4001 ? "Cancelled." : `❌ ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // ── MODULE 2: Submit delivery ────────────────────────────────────────────
  const deliverOrder = async (orderId) => {
    const file = deliveryFiles[orderId]
    if (!file) {
      setTxStatus("❌ Please select a file to upload first.")
      return
    }
    setLoading(true)

    // Step 1: Upload to Pinata / IPFS
    setTxStatus("⏳ Applying watermark and uploading both versions to IPFS...")
    let cid
    try {
      cid = await uploadDelivery(file)
    } catch (err) {
      setTxStatus(`❌ IPFS upload failed: ${err.message}`)
      setLoading(false)
      return
    }

    // Step 2: Submit CID on-chain
    setTxStatus("⏳ Submitting delivery CID on-chain...")
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      // confirmShipment(uint256 productId, string deliveryIpfsHash)
      const tx = await contract.confirmShipment(orderId, cid)
      await tx.wait()
      setMyOrders(prev =>
        prev.map(o => o.id === orderId ? { ...o, status: 2, deliveryCid: cid } : o)
      )
      setDeliveryFiles(prev => { const next = { ...prev }; delete next[orderId]; return next })
      onTxComplete?.()
      setTxStatus(`✅ Delivered! IPFS CID: ${cid}`)
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
      // raiseDispute(uint256 productId) — deducts 0.5 ETH from both parties' deposits
      const tx = await contract.raiseDispute(orderId)
      await tx.wait()
      setMyOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: 4 } : o))
      onTxComplete?.()
      setTxStatus("⚠️ Dispute raised. Funds frozen. Waiting for Juror votes...")
    } catch (err) {
      setTxStatus(err.code === 4001 ? "Cancelled." : `❌ ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // ── Derived lists ────────────────────────────────────────────────────────
  const ongoingOrders = myOrders.filter(o => [1, 2, 4].includes(o.status))
  const historyOrders = myOrders.filter(o => [3, 5].includes(o.status))

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER FUNCTIONS
  // ─────────────────────────────────────────────────────────────────────────

  const fetchRequirementsMeta = async (cid) => {
    if (!cid || requirementsMeta[cid]) return
    setRequirementsMeta(prev => ({ ...prev, [cid]: "loading" }))
    try {
      const res = await fetch(ipfsGatewayUrl(cid))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setRequirementsMeta(prev => ({ ...prev, [cid]: data }))
    } catch {
      setRequirementsMeta(prev => ({ ...prev, [cid]: "error" }))
    }
  }

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
                onClick={() => {
                  const next = expandedId === listing.id ? null : listing.id
                  setExpandedId(next)
                  if (next !== null) fetchRequirementsMeta(listing.cid)
                }}
              >
                {expandedId === listing.id ? "Collapse ↑" : "View Details ↓"}
              </button>
              {listing.clientFull?.toLowerCase() === account?.toLowerCase()
                ? (
                  <div style={styles.ownOrderBadge}>Your Order — Cannot Accept</div>
                ) : (
                  <button
                    style={styles.primaryBtn}
                    onClick={() => acceptOrder(listing)}
                    disabled={loading}
                  >
                    {loading ? "Processing..." : `Accept Order (${listing.price} ETH) →`}
                  </button>
                )
              }
            </div>

            {expandedId === listing.id && (
              <div style={styles.expandBox}>
                {(() => {
                  const meta = requirementsMeta[listing.cid]
                  if (!listing.cid) return <p style={styles.expandNote}>No requirements CID attached.</p>
                  if (!meta || meta === "loading") return <p style={styles.expandNote}>⏳ Loading requirements from IPFS...</p>
                  if (meta === "error") return (
                    <>
                      <div style={styles.cidText}>📦 CID: {listing.cid}</div>
                      <p style={styles.expandNote}>⚠️ Could not fetch requirements. <a href={ipfsGatewayUrl(listing.cid)} target="_blank" rel="noopener noreferrer">Open directly ↗</a></p>
                    </>
                  )
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {meta.description   && <div style={styles.reqRow}><span style={styles.reqLabel}>📝 Description</span><span>{meta.description}</span></div>}
                      {meta.style         && <div style={styles.reqRow}><span style={styles.reqLabel}>🎨 Style</span><span>{meta.style}</span></div>}
                      {meta.colorPalette  && <div style={styles.reqRow}><span style={styles.reqLabel}>🎨 Colors</span><span>{meta.colorPalette}</span></div>}
                      {meta.canvasSize    && <div style={styles.reqRow}><span style={styles.reqLabel}>📐 Canvas</span><span>{meta.canvasSize}</span></div>}
                      {meta.deadline      && <div style={styles.reqRow}><span style={styles.reqLabel}>📅 Deadline</span><span>{meta.deadline}</span></div>}
                      {meta.aiTolerance   && <div style={styles.reqRow}><span style={styles.reqLabel}>🤖 AI Policy</span><span>{meta.aiTolerance}</span></div>}
                      {meta.revisions     && <div style={styles.reqRow}><span style={styles.reqLabel}>✏️ Revisions</span><span>{meta.revisions}</span></div>}
                      <div style={{ marginTop: "6px" }}>
                        <a href={ipfsGatewayUrl(listing.cid)} target="_blank" rel="noopener noreferrer" style={{ fontSize: "11px", color: "#8b5cf6" }}>
                          📦 View raw JSON on IPFS ↗
                        </a>
                      </div>
                    </div>
                  )
                })()}
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
            {order.cid && !order.cid.startsWith("QmFake") && (
              <a href={ipfsGatewayUrl(order.cid)} target="_blank" rel="noopener noreferrer" style={styles.downloadBtn}>
                ⬇ Download Requirements (IPFS)
              </a>
            )}

            {/* Status 1: In Progress (Submit watermarked delivery) */}
            {order.status === 1 && (
              <div style={styles.actionBox}>
                <p style={styles.hintText}>
                  Ready to deliver? Select your watermarked work image and upload it to IPFS.
                </p>
                <label style={styles.fileLabel}>
                  <span style={styles.fileBtn}>🖼 Choose Image</span>
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={e => {
                      const f = e.target.files[0]
                      if (f) setDeliveryFiles(prev => ({ ...prev, [order.id]: f }))
                    }}
                  />
                </label>
                {deliveryFiles[order.id] && (
                  <div style={styles.fileName}>📎 {deliveryFiles[order.id].name}</div>
                )}
                <button
                  style={{
                    ...styles.deliverBtn,
                    opacity: deliveryFiles[order.id] ? 1 : 0.45,
                    cursor: deliveryFiles[order.id] ? "pointer" : "not-allowed",
                    marginTop: "10px",
                  }}
                  onClick={() => deliverOrder(order.id)}
                  disabled={loading || !deliveryFiles[order.id]}
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
  reqRow:   { display: "flex", gap: "10px", fontSize: "13px", lineHeight: "1.5" },
  reqLabel: { minWidth: "110px", color: "#8b8b8b", flexShrink: 0 },
  reputationNote: { fontSize: "12px", color: "#a8f5d4", marginTop: "8px" },
  
  // Button
  
  primaryBtn: { padding: "10px 20px", background: "#a8f5d4", color: "#0d0d0f", border: "none", borderRadius: "8px", fontSize: "13px", fontWeight: "700", cursor: "pointer", whiteSpace: "nowrap" },
  ownOrderBadge: { padding: "10px 16px", background: "rgba(255,255,255,0.04)", color: "rgba(232,230,222,0.35)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "8px", fontSize: "12px", fontStyle: "italic", whiteSpace: "nowrap" },
  ghostBtn: { padding: "10px 16px", background: "transparent", color: "rgba(232,230,222,0.5)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", fontSize: "13px", cursor: "pointer" },
  deliverBtn: { width: "100%", padding: "12px", background: "rgba(168,245,212,0.1)", border: "1px solid rgba(168,245,212,0.3)", borderRadius: "8px", color: "#a8f5d4", fontSize: "13px", fontWeight: "700", cursor: "pointer" },
  downloadBtn: { display: "block", width: "100%", padding: "9px", background: "rgba(168,245,212,0.07)", border: "1px solid rgba(168,245,212,0.2)", borderRadius: "8px", color: "#a8f5d4", fontSize: "12px", textAlign: "center", textDecoration: "none", margin: "6px 0" },
  dangerBtn: { width: "100%", padding: "10px", background: "transparent", border: "1px solid rgba(255,139,139,0.35)", borderRadius: "8px", color: "#ff8b8b", fontSize: "13px", cursor: "pointer" },
  magicBtn: { width: "100%", padding: "9px", background: "rgba(255,255,255,0.03)", border: "1px dashed rgba(255,255,255,0.12)", borderRadius: "8px", color: "#666", cursor: "pointer", fontSize: "12px", marginTop: "8px" },
  fileLabel: { display: "inline-block", cursor: "pointer", marginBottom: "8px" },
  fileBtn: { display: "inline-block", padding: "8px 16px", background: "rgba(168,245,212,0.08)", border: "1px solid rgba(168,245,212,0.25)", borderRadius: "8px", color: "#a8f5d4", fontSize: "13px", fontWeight: "600" },
  fileName: { fontSize: "12px", color: "rgba(232,230,222,0.55)", marginBottom: "4px", wordBreak: "break-all" },
  
  // Tags
  ongoingTag: { fontSize: "12px", color: "#a8f5d4", background: "rgba(168,245,212,0.1)", padding: "3px 8px", borderRadius: "6px" },
  disputeTag: { fontSize: "12px", color: "#ff8b8b", background: "rgba(255,139,139,0.1)", padding: "3px 8px", borderRadius: "6px" },
  completedTag: { fontSize: "12px", color: "#a8f5d4", border: "1px solid rgba(168,245,212,0.4)", padding: "3px 8px", borderRadius: "6px" },
  closedTag: { fontSize: "12px", color: "#666", border: "1px solid rgba(255,255,255,0.1)", padding: "3px 8px", borderRadius: "6px" },
  empty: { color: "#555", fontStyle: "italic", textAlign: "center", padding: "40px 0", fontSize: "14px" },
}
