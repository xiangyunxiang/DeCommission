/**
 * JurorPage.jsx — Juror Voting Interface
 *
 * ─────────────────────────────────────────────────────────────
 * ELIGIBILITY GATE [Proposal's reputation-based whitelist mechanism.]
 * ─────────────────────────────────────────────────────────────
 * Unlocked when completedCount ≥ 10.
 *
 * completedCount (computed in App.jsx) must include BOTH roles:
 *   - Client orders with status 3 (Completed / approved by Client)
 *   - Artist orders with status 3 (Payment Received)
 * Both count equally toward the 10-order threshold.
 * Orders closed via dispute (status 5) do NOT count.
 *
 * ─────────────────────────────────────────────────────────────
 * REAL CONTRACT CALLS
 * ─────────────────────────────────────────────────────────────
 *   - fetchDisputes()                     loads assigned disputes from DisputeManager
 *   - payStake(disputeId)                 payable 0.1 ETH — unlocks evidence access
 *   - castVote(disputeId, supportClient)  no extra ETH (already staked)
 *   - abstain(disputeId)                  triggers stake refund via withdrawStake
 *
 * ─────── Dispute Invitation ────────────────────────────────────────────────
 * DisputeManager.getReviewerDisputeDetails(account) returns all disputes
 * this reviewer is assigned to, plus their per-dispute stake/vote state.
 *
 * ─── VOTING STATE MACHINE (per dispute card) ─────────────────
 *   "invited"   Initial state. Juror sees case info but evidence
 *               is locked. Must pay 0.1 ETH stake to proceed.
 *               If deadline passes before staking → card disappears.
 *
 *   "staked"    Stake paid. Evidence CIDs are now unlocked.
 *               Countdown still ticking.
 *               Juror can vote (support Client / Artist) or abstain.
 *
 *   "voted"     Vote cast. Card moves to "Awaiting Verdict" section.
 *               Choice is locked. Stake returned if majority; forfeited if minority.
 *
 *   "abstained" Juror chose to abstain. Stake refunded immediately.
 *               Card disappears.
 *
 * ─────── Blind Voting ────────────────────────────────────────────────
 *   Jurors CANNOT see current vote tally or number of participants.
 *   Only evidence files + countdown are visible before voting.
 */

import { useState, useEffect, useMemo } from "react"
import { ethers } from "ethers"
import { CONTRACT_ADDRESS, CONTRACT_ABI, DISPUTE_MANAGER_ADDRESS, DISPUTE_MANAGER_ABI,
         REVIEWER_REGISTRY_ADDRESS, REVIEWER_REGISTRY_ABI } from "../contract/config.js"


// ─────────────────────────────────────────────────────────────────────────────
export default function JurorPage({ signer, account, completedCount, onPendingCountChange }) {

  const REQUIRED = 10
  const isEligible = completedCount >= REQUIRED

  // Per-dispute state: { [disputeId]: "invited" | "staked" | "voted" | "abstained" }
  const [disputePhase, setDisputePhase] = useState({})

  // Which dispute's evidence panel is open
  const [expanded, setExpanded] = useState(null)

  // voted choice label: { [disputeId]: "Client" | "Artist" }
  const [voteChoice, setVoteChoice] = useState({})

  const [disputes, setDisputes] = useState([])
  const [loading, setLoading]   = useState(false)
  const [txStatus, setTxStatus] = useState("")
  const [now, setNow]           = useState(Date.now())

  // Juror pool registration state
  const [isRegistered, setIsRegistered] = useState(false)
  const [poolSize, setPoolSize]         = useState(null)
  const [poolMembers, setPoolMembers]   = useState([])   // full address list
  const [regLoading, setRegLoading]     = useState(false)

  // Real-time countdown ticker
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Load invitations when eligible and wallet is connected
  useEffect(() => {
    if (isEligible && signer && account) {
      fetchDisputes()
    }
  }, [isEligible, signer, account])

  // Load pool registration status whenever wallet connects
  useEffect(() => {
    if (signer && account) fetchRegistrationStatus()
  }, [signer, account])

  // ── Juror pool registration status ────────────────────────────────────────
  const fetchRegistrationStatus = async () => {
    try {
      const reg = new ethers.Contract(REVIEWER_REGISTRY_ADDRESS, REVIEWER_REGISTRY_ABI, signer)
      const [registered, members] = await Promise.all([
        reg.isReviewer(account),
        reg.getPool(),
      ])
      const arr = Array.from(members)
      setIsRegistered(registered)
      setPoolSize(arr.length)
      setPoolMembers(arr)
    } catch (err) {
      console.warn("fetchRegistrationStatus failed:", err.message)
    }
  }

  // ── Register as juror in the pool ────────────────────────────────────────
  // Uses forceRegister (no sales requirement) so any account can join in the
  // local dev environment to populate the pool for dispute testing.
  const registerAsJuror = async () => {
    if (!signer) { alert("Connect your wallet first."); return }
    setRegLoading(true)
    setTxStatus("⏳ Registering you in the juror pool...")
    try {
      const reg = new ethers.Contract(REVIEWER_REGISTRY_ADDRESS, REVIEWER_REGISTRY_ABI, signer)
      const tx = await reg.forceRegister(account)
      await tx.wait()
      setIsRegistered(true)
      setPoolMembers(prev => [...prev, account])
      setPoolSize(prev => (prev ?? 0) + 1)
      setTxStatus("✅ You are now in the juror pool. Pool size updated.")
    } catch (err) {
      const msg = err.reason || err.shortMessage || err.message
      setTxStatus(msg?.includes("Already a reviewer")
        ? "ℹ️ You are already registered as a juror."
        : `❌ ${msg}`)
      if (msg?.includes("Already a reviewer")) {
        setIsRegistered(true)
        await fetchRegistrationStatus()
      }
    } finally {
      setRegLoading(false)
    }
  }

  // ── Fetch real dispute invitations from chain ────────────────────────────
  // DisputeManager.getReviewerDisputeDetails(account) returns all disputes
  // this reviewer is assigned to, plus their per-dispute stake/vote state.
  // We also load each product to get price + IPFS CIDs.
  const fetchDisputes = async () => {
    setLoading(true)
    try {
      const dm       = new ethers.Contract(DISPUTE_MANAGER_ADDRESS, DISPUTE_MANAGER_ABI, signer)
      const market   = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer)
      const raw      = await dm.getReviewerDisputeDetails(account)

      const mapped = await Promise.all(Array.from(raw).map(async d => {
        const productId = Number(d.productId)
        let product = null
        try { product = await market.getProduct(productId) } catch (_) {}

        return {
          id:           productId,
          orderId:      productId,
          escrowAmount: product ? ethers.formatEther(product.price) : "?",
          clientAddr:   d.buyer.slice(0, 6) + "..." + d.buyer.slice(-4),
          artistAddr:   d.seller.slice(0, 6) + "..." + d.seller.slice(-4),
          deadlineTs:   Number(d.deadline) * 1000,
          resolved:     d.resolved,
          buyerWon:     d.buyerWon,
          myHasStaked:  d.myHasStaked,
          myHasVoted:   d.myHasVoted,
          myVote:       Number(d.myVote),  // 0=None, 1=BuyerWins, 2=SellerWins
          description:  `Commission #${productId} — review the evidence files below to make your decision.`,
          evidenceCids: {
            requirementsCid: product?.ipfsHash         || null,
            watermarkedWork:  product?.deliveryIpfsHash || null,
          },
        }
      }))

      setDisputes(mapped)

      // Restore per-dispute phase and vote choice from on-chain state
      const initPhase  = {}
      const initChoice = {}
      mapped.forEach(d => {
        if (d.myHasVoted) {
          initPhase[d.id]  = "voted"
          initChoice[d.id] = d.myVote === 1 ? "Client" : "Artist"
        } else if (d.myHasStaked) {
          initPhase[d.id]  = "staked"
        } else {
          initPhase[d.id]  = "invited"
        }
      })
      setDisputePhase(initPhase)
      setVoteChoice(initChoice)
    } catch (err) {
      console.error("fetchDisputes failed:", err)
      setTxStatus(`❌ Failed to load disputes: ${err.reason || err.shortMessage || err.message}`)
    } finally {
      setLoading(false)
    }
  }


  // ── Helpers ───────────────────────────────────────────────────────────────
  const formatCountdown = (deadlineTs) => {
    const diff = Math.max(0, deadlineTs - now)
    if (diff === 0) return "Expired"
    const h = Math.floor(diff / 3600000)
    const m = Math.floor((diff % 3600000) / 60000)
    const s = Math.floor((diff % 60000) / 1000)
    return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`
  }

  const isExpired = (deadlineTs) => deadlineTs - now <= 0

  const setPhase = (id, phase) =>
    setDisputePhase(prev => ({ ...prev, [id]: phase }))

  // ── MODULE 2: Pay stake to unlock evidence ────────────────────────────────
  // pay stake → see evidence → decide to vote or abstain
  const payStake = async (disputeId) => {
    if (!signer) { alert("Please connect your wallet."); return }
    setLoading(true)
    setTxStatus("⏳ Paying 0.1 ETH participation stake to unlock evidence...")
    try {
      const dm = new ethers.Contract(DISPUTE_MANAGER_ADDRESS, DISPUTE_MANAGER_ABI, signer)
      // stakeToEnter(uint256 productId) payable — locks 0.1 ETH, unlocks evidence access
      const tx = await dm.stakeToEnter(disputeId, { value: ethers.parseEther("0.1") })
      await tx.wait()
      setPhase(disputeId, "staked")
      setTxStatus("✅ Stake paid. Evidence files are now accessible.")
    } catch (err) {
      setTxStatus(err.code === 4001 ? "Cancelled." : `❌ ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // ── MODULE 2: Cast vote (after stake is paid) ─────────────────────────────
  // DisputeManager Vote enum: 0=None, 1=BuyerWins, 2=SellerWins
  const castVote = async (disputeId, supportClient) => {
    if (!signer) { alert("Please connect your wallet."); return }
    setLoading(true)
    const label = supportClient ? "Client" : "Artist"
    setTxStatus(`⏳ Submitting your vote to support ${label}...`)
    try {
      const dm = new ethers.Contract(DISPUTE_MANAGER_ADDRESS, DISPUTE_MANAGER_ABI, signer)
      // castVote(uint256 productId, Vote vote) — 1=BuyerWins, 2=SellerWins
      const voteEnum = supportClient ? 1 : 2
      const tx = await dm.castVote(disputeId, voteEnum)
      await tx.wait()
      setVoteChoice(prev => ({ ...prev, [disputeId]: label }))
      setPhase(disputeId, "voted")
      setTxStatus(`✅ Vote locked in. Support ${label}. Awaiting verdict.`)
    } catch (err) {
      setTxStatus(err.code === 4001 ? "Cancelled." : `❌ ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // ── MODULE 2: Abstain (exit & stake returned) ────────────────────────
  const abstain = async (disputeId) => {
    if (!signer) { alert("Please connect your wallet."); return }
    setLoading(true)
    setTxStatus("⏳ Choosing abstention, stake will be refunded...")
    try {
      const dm = new ethers.Contract(DISPUTE_MANAGER_ADDRESS, DISPUTE_MANAGER_ABI, signer)
      // withdrawStake(uint256 productId) — exits round, triggers 0.1 ETH refund
      const tx = await dm.withdrawStake(disputeId)
      await tx.wait()
      setPhase(disputeId, "abstained")
      setTxStatus("✅ Abstained. Your 0.1 ETH stake has been refunded.")
    } catch (err) {
      setTxStatus(err.code === 4001 ? "Cancelled." : `❌ ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // ─── JUROR POOL REGISTRATION PANEL (always rendered) ───────────────────────
  const renderPoolPanel = () => (
    <div style={styles.poolPanel}>
      <div style={styles.poolPanelHeader}>
        <div>
          <div style={styles.poolPanelTitle}>⚖️ Juror Pool</div>
          <div style={styles.poolPanelSub}>
            {poolSize === null
              ? "Loading pool info..."
              : `${poolSize} registered — ${poolSize >= 5 ? "✅ enough for disputes" : `⚠️ need ${5 - poolSize} more minimum (5 needed, excluding buyer & seller per dispute)`}`
            }
          </div>
        </div>
        {isRegistered
          ? <div style={styles.registeredBadge}>✅ You are in the pool</div>
          : (
            <button
              style={styles.registerBtn}
              onClick={registerAsJuror}
              disabled={regLoading || !signer}
            >
              {regLoading ? "Registering..." : "Participate as Juror"}
            </button>
          )
        }
      </div>

      {/* Pool member list */}
      {poolMembers.length > 0 && (
        <div style={styles.poolMemberList}>
          {poolMembers.map((addr, i) => (
            <div key={addr} style={styles.poolMemberRow}>
              <span style={styles.poolMemberIndex}>{i + 1}</span>
              <span style={styles.poolMemberAddr}>{addr}</span>
              {addr.toLowerCase() === account?.toLowerCase() && (
                <span style={styles.youBadge}>You</span>
              )}
            </div>
          ))}
        </div>
      )}

      <p style={styles.poolPanelNote}>
        Disputes require 5 randomly selected jurors, excluding the buyer and seller.
        Switch MetaMask accounts and click “Participate as Juror” for each one to fill the pool.
        Once assigned to a dispute, a 0.1 ETH stake is required to unlock evidence and vote.
      </p>
    </div>
  )

  // ─── LOCKED STATE ───────────────────────────────────────────────────────────
  if (!isEligible) {
    return (
      <div style={styles.page}>
        {renderPoolPanel()}
        {txStatus && <div style={styles.statusBar}>{txStatus}</div>}
        <div style={styles.lockedCard}>
          <div style={styles.lockIcon}>🔒</div>
          <h2 style={styles.lockTitle}>Juror Panel — Locked</h2>
          <p style={styles.lockText}>
            Juror eligibility requires a proven track record of smooth transactions.
            Both Client and Artist completed orders count equally.
          </p>
          <div style={styles.progressBarWrap}>
            <div style={styles.progressBarTrack}>
              <div
                style={{
                  ...styles.progressBarFill,
                  width: `${Math.min(100, (completedCount / REQUIRED) * 100)}%`
                }}
              />
            </div>
            <div style={styles.progressLabel}>
              <span style={styles.progressNum}>{completedCount}</span>
              <span style={styles.progressDenom}> / {REQUIRED} completed orders</span>
            </div>
          </div>
          <p style={styles.lockNote}>
            Client/Artist orders ended as status "Completed"/"Payment Received" count. <br/>
            Orders closed with dispute resolution do not contribute to eligibility.
          </p>
        </div>
      </div>
    )
  }

  // ── Partition disputes by phase ───────────────────────────────────────────
  // Cards to show: invited (not expired) + staked
  // Cards to hide: abstained + expired-while-invited
  // Cards in "awaiting verdict": voted
  const activeCards = useMemo(() => disputes.filter(d => {
    const phase = disputePhase[d.id]
    if (phase === "abstained") return false
    if (phase === "invited" && isExpired(d.deadlineTs)) return false
    if (phase === "voted") return false
    return true
  }), [disputes, disputePhase, now])

  const awaitingCards = useMemo(() =>
    disputes.filter(d => disputePhase[d.id] === "voted"),
    [disputes, disputePhase]
  )
  const hasNothing = activeCards.length === 0 && awaitingCards.length === 0

  //Number of invited dispute hint
  useEffect(() => {
    if (onPendingCountChange) {
      onPendingCountChange(activeCards.length)
    }
  }, [activeCards.length])  

  // ─── ACTIVE DISPUTES ───────────────────────────────────────────────────────
  return (
    <div style={styles.page}>

      {renderPoolPanel()}

      {/* Header banner */}
      <div style={styles.jurorHeader}>
        <div>
          <div style={styles.jurorTitle}>Juror Panel</div>
          <div style={styles.jurorSub}>
            You have been randomly selected to review the following disputes.<br/>
            Voting progress is blind. You cannot see other Jurors' choices or the current tally.
          </div>
        </div>
        <div style={styles.stakeBadge}>Participation stake: 0.1 ETH</div>
      </div>

      {txStatus && <div style={styles.statusBar}>{txStatus}</div>}

      {hasNothing && (
        <div style={styles.empty}>
          No active dispute invitations at the moment.<br/>
          A notification will be sent when a new case is assigned to you.
        </div>
      )}

      {/* ── Active cards: invited / staked ── */}
      {activeCards.map(dispute => {
        const phase   = disputePhase[dispute.id] ?? "invited"
        const expired = isExpired(dispute.deadlineTs)
        const isOpen  = expanded === dispute.id
        const staked  = phase === "staked"

        return (
          <div key={dispute.id} style={styles.disputeCard}>

            {/* ── Header ── */}
            <div style={styles.cardHeader}>
              <div>
                <div style={styles.metaRow}>
                  <span style={styles.caseId}>Case #{dispute.id}</span>
                  <span style={styles.orderRef}>Order #{dispute.orderId}</span>
                  <span style={expired ? styles.expiredTag : styles.countdownTag}>
                    {expired ? "⛔ Expired" : `⏱ ${formatCountdown(dispute.deadlineTs)}`}
                  </span>
                  {staked && <span style={styles.stakedTag}>🔓 Evidence Unlocked</span>}
                </div>
                <p style={styles.disputeDesc}>{dispute.description}</p>
              </div>
              <div style={styles.escrowBlock}>
                <div style={styles.escrowAmount}>{dispute.escrowAmount} ETH</div>
                <div style={styles.escrowLabel}>in escrow</div>
              </div>
            </div>

            {/* ── Phase 1: Pay stake (invited phase) ── */}
            {phase === "invited" && !expired && (
              <div style={styles.stepBox}>
                <div style={styles.stepLabel}>Phase 1: Pay participation stake to unlock evidence</div>
                <p style={styles.stepHint}>
                  A 0.1 ETH stake is required to access the evidence files and cast your vote.
                  If you abstain after staking, your stake will be refunded in full.
                  If you do not stake before the deadline, this invitation will expire.
                </p>
                <button style={styles.stakeBtn} onClick={() => payStake(dispute.id)} disabled={loading}>
                  {loading ? "Processing..." : "Pay 0.1 ETH to Unlock Evidence →"}
                </button>
              </div>
            )}

            {/* ── Phase 2: View evidence + vote (staked phase) ── */}
            {staked && (
              <>
                {/* Evidence panel */}
                <button
                  style={styles.evidenceToggle}
                  onClick={() => setExpanded(isOpen ? null : dispute.id)}
                >
                  {isOpen ? "Hide Evidence ↑" : "Phase 2: View Evidence Files ↓"}
                </button>

                {isOpen && (
                  <div style={styles.evidenceBox}>
                    <p style={styles.evidenceNote}>
                      The following IPFS CIDs grant you temporary access to dispute evidence.<br/>
                      You only can see the watermarked files (such as low-resolution deliverables, preliminary sketches etc).
                    </p>
                    <div style={styles.cidRow}>
                      <span style={styles.cidLabel}>Requirements CID:</span>
                      <span style={styles.cidValue}>{dispute.evidenceCids.requirementsCid ?? "Not available"}</span>
                    </div>
                    <div style={styles.cidRow}>
                      <span style={styles.cidLabel}>Watermarked delivery:</span>
                      <span style={styles.cidValue}>{dispute.evidenceCids.watermarkedWork ?? "Not submitted yet"}</span>
                    </div>
                    <div style={styles.blindReminder}>
                      🔒 Blind voting is enforced. Vote counts and other Jurors' choices are hidden
                      until the outcome is released.
                    </div>
                  </div>
                )}

                {/* Vote buttons */}
                {!expired ? (
                  <div style={styles.voteSection}>
                    <div style={styles.stepLabel}>Phase 3: Cast your vote (Cannot be modified after decide)</div>
                    <div style={styles.voteRow}>
                      <button style={styles.voteClientBtn} onClick={() => castVote(dispute.id, true)}  disabled={loading}>
                        Support Client
                      </button>
                      <button style={styles.voteArtistBtn} onClick={() => castVote(dispute.id, false)} disabled={loading}>
                        Support Artist
                      </button>
                      <button style={styles.abstainBtn}    onClick={() => abstain(dispute.id)}          disabled={loading}>
                        Abstain (stake returned)
                      </button>
                    </div>
                    <p style={styles.stakeReminder}>
                      Voting requires a 0.1 ETH participation stake.
                      Majority voters receive their stake back plus a share of the penalty pool.
                      Minority voters forfeit their stake.
                    </p>
                  </div>
                ) : (
                  <div style={styles.expiredNotice}>
                    Voting period ended for this case. Awaiting system resolution.
                  </div>
                )}
              </>
            )}

        </div>
        )
      })}

      {/* ── Awaiting verdict section ── */}
      {awaitingCards.length > 0 && (
        <div style={styles.awaitingSection}>
          <div style={styles.sectionLabel}>Awaiting Verdict</div>
          {awaitingCards.map(dispute => (
            <div key={dispute.id} style={{ ...styles.disputeCard, opacity: 0.65 }}>
              <div style={styles.cardHeader}>
                <div>
                  <div style={styles.metaRow}>
                    <span style={styles.caseId}>Case #{dispute.id}</span>
                    <span style={styles.orderRef}>Order #{dispute.orderId}</span>
                    <span style={styles.waitingTag}>
                      ⏳ Waiting for result
                    </span>
                  </div>
                  <p style={styles.disputeDesc}>{dispute.description}</p>
                  <p style={styles.voteReceipt}>
                    Your vote: <strong>Support {voteChoice[dispute.id]}</strong>
                  </p>
                </div>
                <div style={styles.escrowBlock}>
                  <div style={styles.escrowAmount}>{dispute.escrowAmount} ETH</div>
                  <div style={styles.escrowLabel}>in escrow</div>
                </div>
              </div>
              <p style={{ fontSize: "12px", color: "#555", marginTop: "4px" }}>
                Result will be announced once all votes are collected or the round closes.
                Blind voting. No tally will be shown before the verdict.
              </p>
            </div>
          ))}
        </div>
      )}

    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const styles = {
  page: { padding: "32px 40px", maxWidth: "900px", margin: "0 auto" },

  // Locked state
  lockedCard: { textAlign: "center", maxWidth: "480px", margin: "80px auto", padding: "48px 40px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "20px" },
  lockIcon: { fontSize: "40px", marginBottom: "16px" },
  lockTitle: { fontSize: "20px", fontWeight: "600", color: "#fff", marginBottom: "12px" },
  lockText: { fontSize: "14px", color: "#888", lineHeight: "1.7", marginBottom: "28px" },
  progressBarWrap: { marginBottom: "20px" },
  progressBarTrack: { height: "6px", background: "rgba(255,255,255,0.08)", borderRadius: "3px", marginBottom: "10px", overflow: "hidden" },
  progressBarFill: { height: "100%", background: "#a8f5d4", borderRadius: "3px", transition: "width 0.3s" },
  progressLabel: { fontSize: "14px", color: "#ccc", textAlign: "left" },
  progressNum: { fontSize: "20px", fontWeight: "700", color: "#a8f5d4" },
  progressDenom: { color: "#666" },
  lockNote: { fontSize: "12px", color: "#555", lineHeight: "1.6" },

  // Header
  jurorHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "24px", gap: "20px" },
  jurorTitle: { fontSize: "20px", fontWeight: "600", color: "#fff", marginBottom: "4px" },
  jurorSub: { fontSize: "13px", color: "#666", lineHeight: "1.6", maxWidth: "500px" },
  stakeBadge: { padding: "8px 16px", background: "rgba(168,245,212,0.08)", border: "1px solid rgba(168,245,212,0.2)", borderRadius: "20px", fontSize: "13px", color: "#a8f5d4", whiteSpace: "nowrap" },
  
  statusBar: { padding: "12px 18px", background: "rgba(168,245,212,0.07)", border: "1px solid rgba(168,245,212,0.2)", borderRadius: "10px", marginBottom: "20px", fontSize: "13px", color: "#a8f5d4" },

  // Dispute card
  disputeCard: { background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "14px", padding: "22px", marginBottom: "16px" },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", marginBottom: "14px" },
  metaRow: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px", flexWrap: "wrap" },
  caseId: { fontSize: "13px", fontWeight: "700", color: "#fff" },
  orderRef: { fontSize: "12px", color: "#666", fontFamily: "monospace" },
  disputeDesc: { fontSize: "14px", color: "#aaa", lineHeight: "1.6" },
  escrowBlock: { textAlign: "right", flexShrink: 0 },
  escrowAmount: { fontSize: "20px", fontWeight: "700", color: "#a8f5d4", whiteSpace: "nowrap" },
  escrowLabel: { fontSize: "11px", color: "#666" },

  // Tags
  countdownTag: { fontSize: "12px", color: "#EF9F27", background: "rgba(239,159,39,0.1)", padding: "3px 8px", borderRadius: "6px" },
  expiredTag:   { fontSize: "12px", color: "#888",    background: "rgba(255,255,255,0.06)", padding: "3px 8px", borderRadius: "6px" },
  stakedTag:    { fontSize: "12px", color: "#a8f5d4", background: "rgba(168,245,212,0.1)", padding: "3px 8px", borderRadius: "6px" },
  waitingTag:   { fontSize: "12px", color: "#EF9F27", background: "rgba(239,159,39,0.08)", padding: "3px 8px", borderRadius: "6px" },

  // AI tag
  aiTagPass: { 
    display: "flex", 
    flexDirection: "column", 
    alignItems: "center",    
    justifyContent: "center",
    textAlign: "center",     
    gap: "8px",              
    padding: "16px 20px",    
    background: "rgba(93,202,165,0.06)", 
    border: "1px solid rgba(93,202,165,0.2)", 
    borderRadius: "10px", 
    marginBottom: "16px" 
  },
  aiTagWarn: { 
    display: "flex", 
    flexDirection: "column", 
    alignItems: "center", 
    justifyContent: "center",
    textAlign: "center", 
    gap: "8px", 
    padding: "16px 20px", 
    background: "rgba(239,159,39,0.06)", 
    border: "1px solid rgba(239,159,39,0.25)", 
    borderRadius: "10px", 
    marginBottom: "16px" 
  },
  aiTagIcon: { fontSize: "20px", marginBottom: "4px" },
  aiTagBody: { 
    display: "flex", 
    flexDirection: "column", 
    alignItems: "center", 
    gap: "4px" 
  },
  aiTagTitle: { fontSize: "14px", fontWeight: "600", color: "#ddd", marginBottom: "2px" },
  aiTagNote: { fontSize: "13px", color: "#888", marginBottom: "4px" },
  aiTagDisclaimer: { fontSize: "12px", color: "#555", fontStyle: "italic" },

  // Step boxes
  stepBox: { padding: "16px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "10px", marginBottom: "12px" },
  stepLabel: { fontSize: "12px", fontWeight: "700", color: "#a8f5d4", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: "8px" },
  stepHint: { fontSize: "13px", color: "#888", lineHeight: "1.6", marginBottom: "12px" },
  stakeBtn: { width: "100%", padding: "12px", background: "rgba(168,245,212,0.1)", border: "1px solid rgba(168,245,212,0.3)", borderRadius: "8px", color: "#a8f5d4", fontSize: "14px", fontWeight: "700", cursor: "pointer" },

  // Evidence
  evidenceToggle: { width: "100%", padding: "9px", background: "transparent", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "8px", color: "#888", cursor: "pointer", fontSize: "13px", marginBottom: "4px" },
  evidenceBox: { padding: "14px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "8px", marginBottom: "12px" },
  evidenceNote: { fontSize: "12px", color: "#666", lineHeight: "1.6", marginBottom: "10px" },
  cidRow: { display: "flex", gap: "10px", marginBottom: "6px", flexWrap: "wrap" },
  cidLabel: { fontSize: "11px", color: "#666", minWidth: "160px" },
  cidValue: { fontSize: "11px", color: "#a8f5d4", fontFamily: "monospace" },
  blindVotingReminder: { fontSize: "12px", color: "#EF9F27", marginTop: "10px", padding: "8px 12px", background: "rgba(239,159,39,0.06)", borderRadius: "6px" },

  // Vote
  voteSection: { marginTop: "14px" },
  voteRow: { display: "flex", gap: "10px", margin: "10px 0", flexWrap: "wrap" },
  voteClientBtn: { flex: 1, minWidth: "120px", padding: "11px", background: "rgba(93,202,165,0.12)", border: "1px solid rgba(93,202,165,0.35)", borderRadius: "8px", color: "#a8f5d4", fontSize: "13px", fontWeight: "700", cursor: "pointer" },
  voteArtistBtn: { flex: 1, minWidth: "120px", padding: "11px", background: "rgba(239,159,39,0.1)",  border: "1px solid rgba(239,159,39,0.3)",  borderRadius: "8px", color: "#EF9F27",  fontSize: "13px", fontWeight: "700", cursor: "pointer" },
  abstainBtn:    { flex: 1, minWidth: "120px", padding: "11px", background: "transparent",            border: "1px dashed rgba(255,255,255,0.12)", borderRadius: "8px", color: "#666",    fontSize: "13px", cursor: "pointer" },
  stakeReminder: { fontSize: "11px", color: "#555", lineHeight: "1.5" },
  expiredNotice: { fontSize: "13px", color: "#666", fontStyle: "italic", padding: "10px", background: "rgba(255,255,255,0.03)", borderRadius: "6px", marginTop: "10px" },

  // Awaiting verdict
  awaitingSection: { marginTop: "28px" },
  sectionLabel: { fontSize: "11px", fontWeight: "700", letterSpacing: "0.1em", textTransform: "uppercase", color: "#555", marginBottom: "12px" },
  voteReceipt: { fontSize: "13px", color: "#a8f5d4", marginTop: "4px" },

  empty: { color: "#555", textAlign: "center", padding: "60px 0", fontSize: "14px", lineHeight: "1.8" },

  // Juror pool registration panel
  poolPanel: { background: "rgba(168,245,212,0.04)", border: "1px solid rgba(168,245,212,0.18)", borderRadius: "12px", padding: "18px 22px", marginBottom: "20px" },
  poolPanelHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "16px" },
  poolPanelTitle: { fontSize: "14px", fontWeight: "700", color: "#a8f5d4", marginBottom: "4px" },
  poolPanelSub: { fontSize: "12px", color: "#888" },
  poolPanelNote: { fontSize: "12px", color: "#555", margin: "12px 0 0", lineHeight: "1.7" },
  registeredBadge: { fontSize: "12px", color: "#a8f5d4", background: "rgba(168,245,212,0.08)", border: "1px solid rgba(168,245,212,0.25)", borderRadius: "20px", padding: "6px 14px", whiteSpace: "nowrap" },
  registerBtn: { padding: "9px 18px", background: "#a8f5d4", color: "#0d0d0f", border: "none", borderRadius: "8px", fontSize: "13px", fontWeight: "700", cursor: "pointer", whiteSpace: "nowrap" },
  poolMemberList: { marginTop: "12px", borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: "10px", display: "flex", flexDirection: "column", gap: "5px" },
  poolMemberRow: { display: "flex", alignItems: "center", gap: "10px", fontSize: "12px" },
  poolMemberIndex: { color: "#555", width: "16px", textAlign: "right", flexShrink: 0 },
  poolMemberAddr: { color: "#888", fontFamily: "monospace", fontSize: "11px", flex: 1 },
  youBadge: { fontSize: "10px", color: "#a8f5d4", background: "rgba(168,245,212,0.1)", border: "1px solid rgba(168,245,212,0.2)", borderRadius: "10px", padding: "1px 7px" },
}
