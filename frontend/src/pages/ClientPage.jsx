/**
 * ClientPage.jsx — Buyer Interface
 *
 * ─────────────────────────────────────────────────────────────
 * MODULE 1 · MOCK DATA (pure frontend, no contract needed)
 * ─────────────────────────────────────────────────────────────
 *  - MOCK_ARTISTS        : hardcoded artist cards for Browse tab
 *  - MOCK_HISTORY_ORDERS : pre-filled completed orders to demo
 *                          
 *  - fakeCID generation  : setTimeout + random string, simulates
 *                          IPFS upload without actually doing it
 *  - simulateAccept      : demo-only button so professor can see
 *                          the full flow in one browser window
 *  - simulateDelivery    : same reason as above
 *
 * ─────────────────────────────────────────────────────────────
 * MODULE 2 · REAL CONTRACT CALLS (ethers.js → MetaMask → chain)
 * ─────────────────────────────────────────────────────────────
 *  - fetchMyOrders       : reads live orders from contract on load
 *  - createListing()     : packages form → fake CID → calls
 *                          contract.createCommission(cid, price)
 *                          with ETH escrowed
 *  - confirmCompletion() : calls contract.confirmReceipt(orderId)
 *                          releases escrowed funds to Artist
 *  - raiseDispute()      : calls contract.raiseDispute(orderId)
 *                          freezes funds, triggers Juror process
 */

import { useState, useEffect } from "react"
import { ethers } from "ethers"
import { CONTRACT_ADDRESS, CONTRACT_ABI, DATA_FETCHER_ADDRESS, DATA_FETCHER_ABI } from "../contract/config.js"

// ─── Status labels: (none — mock constants removed) ──────────────────────────

// ─── Status labels: Client perspective ────────────────────────────────────────
const CLIENT_STATUS = {
  0: "Awaiting Artist",
  1: "In Progress",
  2: "Pending Review",   // Artist delivered → Client's turn to act
  3: "Completed",
  4: "In Dispute",
  5: "Closed",           // Dispute resolved and archived
}

// ─────────────────────────────────────────────────────────────────────────────
export default function ClientPage({ signer, account }) {

  const [activeTab, setActiveTab] = useState("browse")   // browse | create | orders
  const [orderTab, setOrderTab]   = useState("listed")   // listed | ongoing | history
  const [loading, setLoading]     = useState(false)
  const [txStatus, setTxStatus]   = useState("")

  // Artists fetched from chain (replaces MOCK_ARTISTS)
  const [artists, setArtists] = useState([])

  // Live orders fetched from the contract
  const [myListings, setMyListings] = useState([])
  const [myOrders, setMyOrders]     = useState([])
  const [fetchError, setFetchError] = useState(null)

  // Create Order form state
  const [formData, setFormData] = useState({
    description: "",
    style: "",
    colorPalette: "",
    canvasSize: "",
    deadline: "",
    aiTolerance: "0% — Human only (No AI)",
    revisions: "2",
    price: "0.1",
  })

  // ── MODULE 2: Load on mount ────────────────────────────────────────────────
  useEffect(() => {
    if (signer) {
      fetchMyOrders()
      fetchArtists()
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

  const fetchMyOrders = async () => {
    setFetchError(null)
    setLoading(true)
    try {
      const fetcher = new ethers.Contract(DATA_FETCHER_ADDRESS, DATA_FETCHER_ABI, signer)
      // Single call via DataFetcher.getBuyerDashboard — returns all commissions + disputes
      const dashboard = await fetcher.getBuyerDashboard(account)
      // Array.from() converts ethers Result proxy to a real JS array before mapping
      const orders = Array.from(dashboard.commissions).map(p => ({
        id:          Number(p.id),
        amount:      ethers.formatEther(p.price),
        status:      Number(p.status),
        cid:         p.ipfsHash,
        deliveryCid: p.deliveryIpfsHash || null,
        artist:      p.seller,
      }))
      setMyOrders(orders)

      // Separate Listed (status 0) orders into the listings view
      const listed = orders.filter(o => o.status === 0)
      setMyListings(listed.map(o => ({
        id:          o.id,
        description: `Commission #${o.id}`,
        price:       o.amount,
        cid:         o.cid,
        aiTolerance: "",
        revisions:   "",
      })))
    } catch (err) {
      console.error("fetchMyOrders failed:", err)
      const msg = err.reason || err.shortMessage || err.message || "Unknown error"
      setFetchError(msg)
    } finally {
      setLoading(false)
    }
  }

  // ── MODULE 2: Fetch active artists from chain ──────────────────────────────
  // Scans all products to find unique seller addresses + their stats.
  // No dedicated contract getter needed — derived from product history.
  const fetchArtists = async () => {
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      const total = Number(await contract.getLatestProductId())
      const sellerMap = {}
      for (let i = 1; i <= total; i++) {
        const p = await contract.getProduct(i)
        const seller = p.seller
        if (seller === ethers.ZeroAddress) continue
        if (!sellerMap[seller]) sellerMap[seller] = { completed: 0, total: 0 }
        sellerMap[seller].total++
        const status = Number(p.status)
        if (status === 3 || status === 5) sellerMap[seller].completed++
      }
      setArtists(Object.entries(sellerMap).map(([addr, s]) => ({
        addressFull: addr,
        address:     addr.slice(0, 6) + "..." + addr.slice(-4),
        completed:   s.completed,
        totalOrders: s.total,
      })))
    } catch (err) {
      console.warn("fetchArtists failed:", err.message)
    }
  }

  // ── IPFS download helper ──────────────────────────────────────────────────
  // Constructs a public IPFS gateway URL from a CID.
  // In production with Pinata: swap gateway to https://gateway.pinata.cloud/ipfs/
  const ipfsUrl = (cid) => `https://ipfs.io/ipfs/${cid}`

  // ── MODULE 2: Create listing → real contract call ────────────────────────
  const createListing = async (e) => {
    e.preventDefault()
    if (!formData.description || !formData.price) {
      alert("Please fill in Description and Price before submitting.")
      return
    }
    if (!signer) {
      alert("Wallet not connected. Please connect MetaMask first.")
      return
    }

    setLoading(true)

    // ── MODULE 1: Simulate IPFS upload ──────────────────────────────────
    // In production: upload JSON blob to IPFS via Pinata / web3.storage,
    // receive a real CID, then pass it to the contract.
    // For MVP: generate a fake CID after a 1.5s loading animation.
    setTxStatus("⏳ Packaging requirements and uploading to IPFS (simulated)...")

    await new Promise(r => setTimeout(r, 1500))

    const requirementsPayload = {
      description:  formData.description,
      style:        formData.style,
      colorPalette: formData.colorPalette,
      canvasSize:   formData.canvasSize,
      deadline:     formData.deadline,
      aiTolerance:  formData.aiTolerance,
      revisions:    formData.revisions,
    }
    // In production: const cid = await uploadToIPFS(JSON.stringify(requirementsPayload))
    const fakeCID = "QmReq" + Math.random().toString(36).substring(2, 10).toUpperCase()
    console.log("Requirements payload (would go to IPFS):", requirementsPayload)

    // ── MODULE 2: Real contract call ─────────────────────────────────────
    setTxStatus("⏳ Waiting for MetaMask confirmation...")
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      const priceInWei = ethers.parseEther(formData.price)

      // createCommission(string ipfsHash, uint256 price) payable
      // The ETH sent = order escrow amount locked by the contract.
      // ⚠ Ensure the user still has ≥ 1 ETH mandatory deposit after this tx.
      //   The contract enforces this on-chain; the UI just shows a warning.
      const tx = await contract.createCommission(fakeCID, priceInWei, { value: priceInWei })
      setTxStatus("⏳ Transaction submitted. Waiting for block confirmation...")
      const receipt = await tx.wait()

      // Add to local listing state for immediate UI feedback
      setMyListings(prev => [...prev, {
        id:          Date.now(),
        description: formData.description,
        price:       formData.price,
        cid:         fakeCID,
        aiTolerance: formData.aiTolerance,
        revisions:   formData.revisions,
      }])

      setTxStatus(`✅ Order listed on-chain! Tx: ${receipt.hash.slice(0, 14)}...`)
      setFormData(prev => ({ ...prev, description: "", price: "0.1" }))
      // Re-fetch from chain so real IDs and status are used
      await fetchMyOrders()
      setActiveTab("orders")
      setOrderTab("listed")
    } catch (err) {
      if (err.code === 4001) {
        setTxStatus("Cancelled — you rejected the transaction in MetaMask.")
      } else if (err.message?.includes("insufficient funds")) {
        setTxStatus("⚠️ Insufficient balance. Remember: order amount + 1 ETH mandatory deposit must remain in your wallet.")
      } else {
        setTxStatus(`❌ Transaction failed: ${err.message}`)
      }
    } finally {
      setLoading(false)
    }
  }

  // ── MODULE 2: Approve order → release funds to Artist ───────────────────
  const confirmCompletion = async (orderId) => {
    setLoading(true)
    setTxStatus("⏳ Waiting for MetaMask confirmation...")
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      const tx = await contract.confirmReceipt(orderId)
      await tx.wait()
      setMyOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: 3 } : o))
      setTxStatus("✅ Confirmed! Escrowed funds released to Artist.")
      setOrderTab("history")
    } catch (err) {
      setTxStatus(err.code === 4001 ? "Cancelled." : `❌ ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // ── MODULE 2: Raise dispute → freeze funds, notify Jurors ───────────────
  const raiseDispute = async (orderId) => {
    setLoading(true)
    setTxStatus("⏳ Raising dispute — MetaMask will prompt for the arbitration deposit...")
    try {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      // Proposal: losing party deposit = 0.2 ETH (used as penalty/pool)
      // ⚠ Confirm exact deposit amount and parameter signature with backend team
      const tx = await contract.raiseDispute(orderId)
      await tx.wait()
      setMyOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: 4 } : o))
      setTxStatus("⚠️ Dispute raised. Funds frozen. Waiting for Jurors' votes...")
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

  const renderBrowse = () => (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
      {artists.length === 0
        ? (
          <div style={{ ...styles.empty, gridColumn: "1 / -1" }}>
            {signer
              ? "No active artists found on chain yet. Artists appear here once they accept at least one commission."
              : "Connect your wallet to see active artists."}
          </div>
        )
        : artists.map(artist => (
          <div key={artist.addressFull} style={styles.card}>
            <div style={styles.artistAddr}>{artist.address}</div>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", margin: "8px 0 10px" }}>
              <span style={styles.pill}>✅ {artist.completed} completed</span>
              <span style={styles.pill}>📦 {artist.totalOrders} total orders</span>
            </div>
            <button
              style={{ ...styles.ghostBtn, width: "100%", marginTop: "4px" }}
              onClick={() => setActiveTab("create")}
            >
              Create Commission →
            </button>
          </div>
        ))
      }
    </div>
  )

  const renderCreate = () => (
    <form onSubmit={createListing} style={styles.formCard}>
      <h3 style={{ color: "#fff", marginBottom: "4px" }}>New Commission Order</h3>
      <p style={{ fontSize: "12px", color: "#666", marginBottom: "24px" }}>
        All fields below will be packaged as JSON and stored on IPFS.
        Only the CID hash and payment amount are written to the blockchain.
      </p>

      {/* Description */}
      <label style={styles.label}>Requirement Description *</label>
      <textarea
        required
        placeholder="Describe what you want in detail, such as character, mood, references, special requirements..."
        style={{ ...styles.input, height: "100px", lineHeight: "1.6", resize: "vertical" }}
        value={formData.description}
        onChange={e => setFormData({ ...formData, description: e.target.value })}
      />

      {/* Style + Colour palette */}
      <div style={{ display: "flex", gap: "16px" }}>
        <div style={{ flex: 1 }}>
          <label style={styles.label}>Art style / technique</label>
          <input
            style={styles.input}
            placeholder="e.g. Cyberpunk / Cel shading"
            value={formData.style}
            onChange={e => setFormData({ ...formData, style: e.target.value })}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={styles.label}>Colour palette preference</label>
          <input
            style={styles.input}
            placeholder="e.g. Dark neon, warm earth tones"
            value={formData.colorPalette}
            onChange={e => setFormData({ ...formData, colorPalette: e.target.value })}
          />
        </div>
      </div>

      {/* Canvas size + Deadline */}
      <div style={{ display: "flex", gap: "16px" }}>
        <div style={{ flex: 1 }}>
          <label style={styles.label}>Canvas / resolution</label>
          <input
            style={styles.input}
            placeholder="e.g. 2000×2000 px, A4 300 dpi"
            value={formData.canvasSize}
            onChange={e => setFormData({ ...formData, canvasSize: e.target.value })}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={styles.label}>Desired completion date</label>
          <input
            type="date"
            style={styles.input}
            value={formData.deadline}
            onChange={e => setFormData({ ...formData, deadline: e.target.value })}
          />
        </div>
      </div>

      {/* AI tolerance + Revisions */}
      <div style={{ display: "flex", gap: "16px" }}>
        <div style={{ flex: 1 }}>
          <label style={styles.label}>AI usage permission</label>
          <select
            style={styles.input}
            value={formData.aiTolerance}
            onChange={e => setFormData({ ...formData, aiTolerance: e.target.value })}
          >
            <option>0% — Human only (No AI)</option>
            <option>Sketch / base only (AI Assisted)</option>
            <option>100% — No restriction</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={styles.label}>Revision rounds included</label>
          <input
            type="number"
            min="0"
            max="7"
            style={styles.input}
            value={formData.revisions}
            onChange={e => setFormData({ ...formData, revisions: e.target.value })}
          />
        </div>
      </div>

      {/* Price */}
      <label style={styles.label}>Your offer price (ETH) *</label>
      <p style={{ fontSize: "12px", color: "#747373", marginBottom: "6px" }}>
        This amount will be locked in the smart contract escrow immediately.
        Make sure your wallet retains ≥ 1 ETH mandatory deposit after payment.
      </p>
      <input
        type="number"
        step="0.01"
        min="0.01"
        required
        style={{ ...styles.input, fontSize: "22px", color: "#a8f5d4", fontWeight: "700" }}
        value={formData.price}
        onChange={e => setFormData({ ...formData, price: e.target.value })}
      />

      <button type="submit" style={styles.primaryBtn} disabled={loading}>
        {loading ? "Processing..." : `Pay & List Order (${formData.price} ETH) →`}
      </button>
    </form>
  )

  const renderOrders = () => (
    <div style={styles.ordersContainer}>
      {/* Fetch error banner */}
      {fetchError && (
        <div style={styles.fetchErrBanner}>
          <span>⚠️ Could not load orders: {fetchError}</span>
          <button style={styles.retryBtn} onClick={() => fetchMyOrders()}>Retry</button>
        </div>
      )}

      {/* Loading indicator */}
      {loading && (
        <div style={{ color: "#666", fontSize: "13px", marginBottom: "12px" }}>⏳ Loading orders from chain...</div>
      )}

      {/* Sub-tab navigation */}
      <div style={styles.subTabContainer}>
        {[
          { key: "listed",  label: `Listed (${myListings.length})` },
          { key: "ongoing", label: `Ongoing (${ongoingOrders.length})` },
          { key: "history", label: `History (${historyOrders.length})` },
        ].map(t => (
          <button
            key={t.key}
            style={orderTab === t.key ? styles.activeSubTab : styles.subTab}
            onClick={() => setOrderTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Listed: waiting for an Artist to accept ── */}
      {orderTab === "listed" && (
        <div>
          {myListings.length === 0
            ? <div style={styles.empty}>No active listings. Head to "New Order" to post one!</div>
            : myListings.map(l => (
              <div key={l.id} style={styles.card}>
                <div style={styles.cardHeader}>
                  <span style={styles.orderId}>Order #{l.id}</span>
                  <span style={styles.waitingTag}>Awaiting Artist</span>
                </div>
                <div style={styles.orderAmount}>{l.price} ETH</div>
                <div style={styles.cidText}>Requirements CID: {l.cid}</div>
                <p style={{ fontSize: "13px", color: "#aaa", margin: "8px 0" }}>
                  {l.description.substring(0, 70)}...
                </p>
              </div>
            ))
          }
        </div>
      )}

      {/* ── Ongoing: in progress / delivered / disputed ── */}
      {orderTab === "ongoing" && (
        <div>
          {ongoingOrders.length === 0
            ? <div style={styles.empty}>No ongoing orders right now.</div>
            : ongoingOrders.map(order => (
              <div key={order.id} style={styles.card}>
                <div style={styles.cardHeader}>
                  <span style={styles.orderId}>Order #{order.id}</span>
                  <span style={order.status === 4 ? styles.disputeTag : styles.ongoingTag}>
                    {CLIENT_STATUS[order.status]}
                  </span>
                </div>
                <div style={styles.orderAmount}>{order.amount} ETH</div>
                <div style={styles.cidText}>Requirements CID: {order.cid}</div>

                {/* Status 1: In Progress — waiting for artist to deliver */}
                {order.status === 1 && (
                  <div style={styles.actionBox}>
                    <p style={styles.hintText}>Artist is working on your commission...</p>
                  </div>
                )}

                {/* Status 2: Delivered & Pending Client Review */}
                {order.status === 2 && (
                  <div style={styles.actionBox}>
                    <p style={styles.hintText}>
                      📥 Artist submitted watermarked work. Please review and decide:
                    </p>
                    {/* IPFS Download Button */}
                    {order.deliveryCid && (
                      <a
                        href={ipfsUrl(order.deliveryCid)}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={styles.downloadBtn}
                      >
                        ⬇ Preview Watermarked Work (IPFS)
                      </a>
                    )}
                    <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
                      <button style={styles.successBtn} onClick={() => confirmCompletion(order.id)} disabled={loading}>
                        {loading ? "..." : "✓ Approve & Release Funds"}
                      </button>
                      <button style={styles.dangerBtn} onClick={() => raiseDispute(order.id)} disabled={loading}>
                        Raise Dispute
                      </button>
                    </div>
                  </div>
                )}

                {/* Status 4: Disputed — waiting for jurors to vote */}
                {order.status === 4 && (
                  <div style={styles.actionBox}>
                    <p style={{ fontSize: "13px", color: "#ff8b8b" }}>
                      Dispute in progress. Jurors are reviewing the evidence...
                    </p>
                  </div>
                )}
              </div>
            ))
          }
        </div>
      )}

      {/* ── History: completed + closed ── */}
      {orderTab === "history" && (
        <div>
          {historyOrders.length === 0
            ? <div style={styles.empty}>No finished orders yet.</div>
            : historyOrders.map(order => (
              <div key={order.id} style={{ ...styles.card, opacity: 0.75 }}>
                <div style={styles.cardHeader}>
                  <span style={styles.orderId}>Order #{order.id}</span>
                  <span style={order.status === 3 ? styles.completedTag : styles.closedTag}>
                    {CLIENT_STATUS[order.status]}
                  </span>
                </div>
                <div style={styles.orderAmount}>{order.amount} ETH</div>
                <div style={styles.cidText}>CID: {order.cid}</div>

                {/* ── IPFS Download Button ── */}
                {order.deliveryCid && (
                  <div style={{ marginTop: "12px", marginBottom: "8px" }}>
                    <a
                      href={ipfsUrl(order.deliveryCid)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ ...styles.downloadBtn, background: order.status === 3 ? "rgba(168,245,212,0.15)" : styles.downloadBtn.background }}
                    >
                      {order.status === 3 
                        ? "💎 Download High-Res Original (Unwatermarked)" 
                        : "📄 Download Delivery Record (IPFS)"}
                    </a>
                  </div>
                )}

                {order.status === 3 && (
                  <p style={styles.reputationNote}>
                    🎉 Successfully completed transaction. Fund released to Artist.
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
      )}
    </div>
  )

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <div style={styles.page}>
      <div style={styles.tabContainer}>
        {[
          { key: "browse", label: "Browse Artists" },
          { key: "create", label: "New Order" },
          { key: "orders", label: "My Orders" },
        ].map(t => (
          <button
            key={t.key}
            style={activeTab === t.key ? styles.activeTab : styles.tab}
            onClick={() => {
              setActiveTab(t.key)
              // Re-fetch when navigating to My Orders so the list is always fresh
              if (t.key === "orders" && signer) fetchMyOrders()
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {txStatus && (
        <div style={styles.statusBar}>{txStatus}</div>
      )}

      <div style={styles.content}>
        {activeTab === "browse"  && renderBrowse()}
        {activeTab === "create"  && renderCreate()}
        {activeTab === "orders"  && renderOrders()}
      </div>
    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const styles = {
  page: { padding: "32px 40px", maxWidth: "900px", margin: "0 auto" },
  tabContainer: { display: "flex", gap: "8px", marginBottom: "24px", borderBottom: "1px solid rgba(255,255,255,0.08)", paddingBottom: "12px" },
  tab: { padding: "10px 20px", background: "transparent", color: "#666", border: "none", cursor: "pointer", fontSize: "15px", fontWeight: "600", borderRadius: "8px" },
  activeTab: { padding: "10px 20px", background: "rgba(168,245,212,0.1)", color: "#a8f5d4", border: "none", cursor: "pointer", fontSize: "15px", fontWeight: "600", borderRadius: "8px" },
  statusBar: { padding: "12px 18px", background: "rgba(168,245,212,0.07)", border: "1px solid rgba(168,245,212,0.2)", borderRadius: "10px", marginBottom: "20px", fontSize: "13px", color: "#a8f5d4" },
  content: { marginTop: "4px" },

  // Browse
  artistAddr: { fontSize: "15px", fontFamily: "monospace", color: "#fff", marginBottom: "4px" },
  activeTag: { fontSize: "11px", color: "#a8f5d4", background: "rgba(168,245,212,0.08)", padding: "2px 8px", borderRadius: "4px", display: "inline-block", marginBottom: "8px" },
  priceLabel: { fontSize: "14px", fontWeight: "600", color: "#a8f5d4" },

  // Create form
  formCard: { background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "14px", padding: "30px" },
  label: { display: "block", fontSize: "13px", color: "rgba(232,230,222,0.55)", marginBottom: "6px", marginTop: "18px", fontWeight: "600", letterSpacing: "0.04em", textTransform: "uppercase" },
  input: { width: "100%", padding: "11px 14px", boxSizing: "border-box", background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", color: "#fff", fontSize: "14px" },
  primaryBtn: { width: "100%", padding: "15px", background: "#a8f5d4", color: "#0d0d0f", border: "none", borderRadius: "8px", fontSize: "15px", fontWeight: "700", cursor: "pointer", marginTop: "24px" },

  // Orders
  ordersContainer: { background: "rgba(255,255,255,0.01)", padding: "20px", borderRadius: "14px", border: "1px solid rgba(255,255,255,0.05)" },
  fetchErrBanner: { display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(255,80,80,0.12)", border: "1px solid rgba(255,80,80,0.3)", borderRadius: "8px", padding: "10px 14px", marginBottom: "14px", color: "#ff9999", fontSize: "13px" },
  retryBtn: { background: "rgba(255,80,80,0.2)", border: "1px solid rgba(255,80,80,0.4)", color: "#ffaaaa", borderRadius: "5px", padding: "4px 12px", cursor: "pointer", fontSize: "12px", fontWeight: "600", marginLeft: "12px" },
  subTabContainer: { display: "flex", gap: "24px", marginBottom: "20px", borderBottom: "1px solid rgba(255,255,255,0.05)", paddingBottom: "12px" },
  subTab: { background: "none", border: "none", color: "#555", fontSize: "14px", cursor: "pointer", padding: "4px 0" },
  activeSubTab: { background: "none", border: "none", color: "#fff", fontSize: "14px", cursor: "pointer", padding: "4px 0", borderBottom: "2px solid #a8f5d4" },

  // Cards
  card: { background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "10px", padding: "18px", marginBottom: "12px" },
  cardHeader: { display: "flex", justifyContent: "space-between", marginBottom: "8px", alignItems: "center" },
  orderId: { color: "#555", fontSize: "12px", fontFamily: "monospace" },
  orderAmount: { fontSize: "22px", color: "#fff", fontWeight: "700", marginBottom: "4px" },
  cidText: { fontSize: "11px", color: "#555", fontFamily: "monospace", marginBottom: "4px" },
  hintText: { fontSize: "13px", color: "#888", marginBottom: "10px", lineHeight: "1.6" },
  actionBox: { marginTop: "12px", padding: "14px", background: "rgba(255,255,255,0.03)", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.06)" },
  reputationNote: { fontSize: "12px", color: "#a8f5d4", marginTop: "8px" },

  

  // Tags
  waitingTag:   { fontSize: "12px", color: "#888",    background: "rgba(255,255,255,0.08)", padding: "3px 8px", borderRadius: "6px" },
  ongoingTag:   { fontSize: "12px", color: "#a8f5d4", background: "rgba(168,245,212,0.1)", padding: "3px 8px", borderRadius: "6px" },
  disputeTag:   { fontSize: "12px", color: "#ff8b8b", background: "rgba(255,139,139,0.1)", padding: "3px 8px", borderRadius: "6px" },
  completedTag: { fontSize: "12px", color: "#a8f5d4", border: "1px solid rgba(168,245,212,0.4)", padding: "3px 8px", borderRadius: "6px" },
  closedTag:    { fontSize: "12px", color: "#666",    border: "1px solid rgba(255,255,255,0.1)", padding: "3px 8px", borderRadius: "6px" },

  // Misc
  pill: { fontSize: "11px", color: "rgba(232,230,222,0.5)", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "20px", padding: "3px 9px" },
  empty: { color: "#555", fontStyle: "italic", textAlign: "center", padding: "36px 0", fontSize: "14px" },
  magicBtn: {},  // removed — demo-only buttons deleted
  ghostBtn: { padding: "9px 16px", background: "transparent", color: "rgba(232,230,222,0.5)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", fontSize: "13px", cursor: "pointer" },
  successBtn: { flex: 1, padding: "10px", background: "#a8f5d4", border: "none", borderRadius: "6px", color: "#000", fontWeight: "700", cursor: "pointer" },
  downloadBtn: { display: "block", width: "100%", padding: "9px", background: "rgba(168,245,212,0.07)", border: "1px solid rgba(168,245,212,0.2)", borderRadius: "8px", color: "#a8f5d4", fontSize: "12px", textAlign: "center", textDecoration: "none", marginBottom: "4px" },
  dangerBtn: { flex: 1, padding: "10px", background: "transparent", border: "1px solid rgba(255,139,139,0.4)", borderRadius: "6px", color: "#ff8b8b", cursor: "pointer" },
}
