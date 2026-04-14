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
 *   - payStake(disputeId)                 payable ETH stake — unlocks evidence access
 *   - castVote(disputeId, supportClient)  no extra ETH (already staked)
 *   - abstain(disputeId)                  triggers stake refund via withdrawStake
 *
 * ─────── Dispute Invitation ────────────────────────────────────────────────
 * DisputeManager.getReviewerDisputeDetails(account) returns all disputes
 * this reviewer is assigned to, plus their per-dispute stake/vote state.
 *
 * ─── VOTING STATE MACHINE (per dispute card) ─────────────────
 *   "invited"   Initial state. Juror sees case info but evidence
 *               is locked. Must pay ETH stake to proceed.
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
import { ipfsGatewayUrl } from "../utils/pinata.js"


// ─────────────────────────────────────────────────────────────────────────────
export default function JurorPage({ signer, account, completedCount, onPendingCountChange, onTxComplete }) {

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

  // deliveryCid -> { watermarkedCid, originalCid } — fetched lazily from IPFS JSON
  const [deliveryMeta, setDeliveryMeta] = useState({})

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
          reviewerStakeRaw: d.reviewerStake, // 保留 BigInt 类型用于合约调用
          reviewerStakeEth: ethers.formatEther(d.reviewerStake), // 用于前端展示
          reviewerCount: Number(d.reviewerCount), // 本次纠纷需要的总人数
        }
      }))

      setDisputes(mapped)

      // Restore per-dispute phase and vote choice from on-chain state
      const initPhase  = {}
      const initChoice = {}
      mapped.forEach(d => {
        if (d.resolved) {
          initPhase[d.id]  = "resolved"
          if (d.myHasVoted) initChoice[d.id] = d.myVote === 1 ? "Client" : "Artist"
        } else if (d.myHasVoted) {
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

  // Fetch delivery metadata JSON { watermarkedCid, originalCid } for a dispute.
  // The on-chain deliveryIpfsHash now points to this JSON envelope, not the image directly.
  const fetchDeliveryMeta = async (deliveryCid) => {
    if (!deliveryCid || deliveryMeta[deliveryCid]) return
    try {
      const res = await fetch(ipfsGatewayUrl(deliveryCid))
      if (!res.ok) return
      const data = await res.json()
      if (data.watermarkedCid && data.originalCid) {
        setDeliveryMeta(prev => prev[deliveryCid] ? prev : { ...prev, [deliveryCid]: data })
      }
    } catch {
      // Legacy order or non-JSON CID — silently skip
    }
  }

  // Auto-fetch delivery meta whenever disputes list changes
  useEffect(() => {
    disputes.forEach(d => {
      if (d.evidenceCids.watermarkedWork) fetchDeliveryMeta(d.evidenceCids.watermarkedWork)
    })
  }, [disputes])

  // ── MODULE: Auto-refresh Dispute State ─────
  useEffect(() => {
    if (!signer || !account) return;
    const dm = new ethers.Contract(DISPUTE_MANAGER_ADDRESS, DISPUTE_MANAGER_ABI, signer);
    
    const refresh = () => fetchDisputes(); 

    dm.on("ReviewerStaked",  refresh)
    dm.on("ReviewerWithdrew", refresh)   // abstain event
    dm.on("VoteCast",         refresh)
    dm.on("DisputeResolved",  refresh)
    dm.on("TieDetected",      refresh)   // new round triggered → reload invitations

    return () => {
      dm.off("ReviewerStaked",  refresh)
      dm.off("ReviewerWithdrew", refresh)
      dm.off("VoteCast",         refresh)
      dm.off("DisputeResolved",  refresh)
      dm.off("TieDetected",      refresh)
    };
  }, [signer, account]);


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
    const dispute = disputes.find(d => d.id === disputeId); // 找到当前纠纷
    const amountRaw = dispute.reviewerStakeRaw; // 使用从合约拿到的原始 BigInt
    setTxStatus(`⏳ Paying ${dispute.reviewerStakeEth} ETH participation stake to unlock evidence...`)
    try {
      const dm = new ethers.Contract(DISPUTE_MANAGER_ADDRESS, DISPUTE_MANAGER_ABI, signer)
      // 动态押金
      const tx = await dm.stakeToEnter(disputeId)
      await tx.wait()
      setPhase(disputeId, "staked")
      onTxComplete?.()
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
      onTxComplete?.()
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
      // withdrawStake(uint256 productId) — exits round, triggers ETH stake refund
      const tx = await dm.withdrawStake(disputeId)
      await tx.wait()
      setPhase(disputeId, "abstained")
      onTxComplete?.()
      setTxStatus("✅ Abstained. Your ETH stake has been refunded.")
    } catch (err) {
      setTxStatus(err.code === 4001 ? "Cancelled." : `❌ ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // ─── JUROR POOL REGISTRATION PANEL (always rendered) ───────────────────────
  const renderRulesPanel = () => (
    <div style={styles.rulesPanel}>
      <div style={styles.rulesPanelHeader}>
        <div style={styles.rulesPanelTitle}>⚖️ Dispute Voting Rules</div>
        {isRegistered
          ? <div style={styles.registeredBadge}>✅ You are a Juror</div>
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
      <div style={styles.rulesGrid}>
        <div style={styles.ruleBlock}>
          <div style={styles.ruleBlockHeader}>Tier 1 — Small</div>
          <div style={styles.ruleBlockValue}>3 Jurors</div>
          <div style={styles.ruleBlockCondition}>Order price &lt; 0.5 ETH</div>
          <div style={styles.ruleBlockDetail}>Juror stake: 0.03 ETH per juror</div>
          <div style={styles.ruleBlockDetail}>Dispute deposit: 0.05 ETH each party</div>
        </div>
        <div style={styles.ruleBlock}>
          <div style={{ ...styles.ruleBlockHeader, color: "#82b1ff" }}>Tier 2 — Medium</div>
          <div style={styles.ruleBlockValue}>5 Jurors</div>
          <div style={styles.ruleBlockCondition}>0.5 ETH ≤ price &lt; 2 ETH</div>
          <div style={styles.ruleBlockDetail}>Juror stake: 0.08 ETH per juror</div>
          <div style={styles.ruleBlockDetail}>Dispute deposit: 0.15 ETH each party</div>
        </div>
        <div style={styles.ruleBlock}>
          <div style={{ ...styles.ruleBlockHeader, color: "#ffc864" }}>Tier 3 — Large</div>
          <div style={styles.ruleBlockValue}>7 Jurors</div>
          <div style={styles.ruleBlockCondition}>Price ≥ 2 ETH</div>
          <div style={styles.ruleBlockDetail}>Juror stake: 0.15 ETH per juror</div>
          <div style={styles.ruleBlockDetail}>Dispute deposit: 0.30 ETH each party</div>
        </div>
      </div>
      <p style={styles.rulesNote}>
        Jurors are randomly selected, excluding buyer and seller. Voting is blind — you cannot see others' votes.
        Majority voters earn their stake back plus a share of the penalty pool. Minority voters forfeit their stake.
      </p>
    </div>
  )

  // ─── LOCKED STATE ───────────────────────────────────────────────────────────
  if (!isEligible) {
    return (
      <div style={styles.page}>
        {renderRulesPanel()}
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
    if (phase === "resolved") return false
    return true
  }), [disputes, disputePhase, now])

  const awaitingCards = useMemo(() =>
    disputes.filter(d => disputePhase[d.id] === "voted" || disputePhase[d.id] === "resolved"),
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

      {renderRulesPanel()}

      {/* Header banner */}
      <div style={styles.jurorHeader}>
        <div>
          <div style={styles.jurorTitle}>Juror Panel</div>
          <div style={styles.jurorSub}>
            You have been randomly selected to review the following disputes.<br/>
            Voting progress is blind. You cannot see other Jurors' choices or the current tally.
          </div>
        </div>
        <div style={styles.stakeBadge}>Participation Stake varies as order value</div>
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
                  ETH stake (varying as order value) is required to access the evidence files and cast your vote.
                  If you abstain after staking, your stake will be refunded in full.
                  If you do not stake before the deadline, this invitation will expire.
                </p>
                <button style={styles.stakeBtn} onClick={() => payStake(dispute.id)} disabled={loading}>
                  {loading ? "Processing..." : `Pay ${dispute.reviewerStakeEth} ETH to Unlock Evidence →`}
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

                {isOpen && (() => {
                  const reqCid = dispute.evidenceCids.requirementsCid
                  const rawDeliveryCid = dispute.evidenceCids.watermarkedWork
                  const meta = rawDeliveryCid ? deliveryMeta[rawDeliveryCid] : null
                  // Prefer resolved watermarkedCid from delivery JSON; fall back to raw CID
                  const watermarkedCid = meta?.watermarkedCid ?? rawDeliveryCid
                  return (
                  <div style={styles.evidenceBox}>
                    <p style={styles.evidenceNote}>
                      The following IPFS CIDs grant you temporary access to dispute evidence.<br/>
                      You only can see the watermarked files (such as low-resolution deliverables, preliminary sketches etc).
                    </p>
                    <div style={styles.cidRow}>
                      <span style={styles.cidLabel}>Requirements CID:</span>
                      {reqCid ? (
                        <a
                          href={ipfsGatewayUrl(reqCid)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={styles.cidLink}
                        >
                          {reqCid}
                        </a>
                      ) : (
                        <span style={styles.cidValue}>Not available</span>
                      )}
                    </div>
                    <div style={styles.cidRow}>
                      <span style={styles.cidLabel}>Watermarked delivery:</span>
                      {watermarkedCid ? (
                        <a
                          href={ipfsGatewayUrl(watermarkedCid)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={styles.cidLink}
                        >
                          {watermarkedCid}
                        </a>
                      ) : (
                        <span style={styles.cidValue}>Not submitted yet</span>
                      )}
                    </div>

                    {/* Inline watermarked image preview */}
                    {watermarkedCid && (
                      <div style={styles.previewSection}>
                        <div style={styles.previewLabel}>🖼 Watermarked Artwork Preview</div>
                        <a
                          href={ipfsGatewayUrl(watermarkedCid)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={styles.previewLink}
                        >
                          <img
                            src={ipfsGatewayUrl(watermarkedCid)}
                            alt="Watermarked delivery preview"
                            style={styles.previewImg}
                            onError={e => { e.target.style.display = 'none' }}
                          />
                        </a>
                        <a
                          href={ipfsGatewayUrl(watermarkedCid)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={styles.openFullBtn}
                        >
                          🔍 Open Full Image in New Tab ↗
                        </a>
                      </div>
                    )}

                    <div style={styles.blindReminder}>
                      🔒 Blind voting is enforced. Vote counts and other Jurors' choices are hidden
                      until the outcome is released.
                    </div>
                  </div>
                  )
                })()}

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
                      Voting requires ETH participation stake, whose amount varies as order value.
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
                    {dispute.resolved ? (
                      <span style={dispute.buyerWon
                        ? styles.resultClientTag
                        : styles.resultArtistTag
                      }>
                        {dispute.buyerWon ? "✅ Client Wins" : "✅ Artist Wins"}
                      </span>
                    ) : (
                      <span style={styles.waitingTag}>
                        ⏳ Waiting for result
                      </span>
                    )}
                  </div>
                  <p style={styles.disputeDesc}>{dispute.description}</p>
                  {voteChoice[dispute.id] && (
                    <p style={styles.voteReceipt}>
                      Your vote: <strong>Support {voteChoice[dispute.id]}</strong>
                      {dispute.resolved && (
                        voteChoice[dispute.id] === (dispute.buyerWon ? "Client" : "Artist")
                          ? <span style={{ color: "#a8f5d4", marginLeft: "8px" }}>— You were in the majority ✓</span>
                          : <span style={{ color: "#f09595", marginLeft: "8px" }}>— You were in the minority ✗</span>
                      )}
                    </p>
                  )}
                </div>
                <div style={styles.escrowBlock}>
                  <div style={styles.escrowAmount}>{dispute.escrowAmount} ETH</div>
                  <div style={styles.escrowLabel}>in escrow</div>
                </div>
              </div>
              {dispute.resolved ? (
                <p style={{ fontSize: "12px", color: "#a8f5d4", marginTop: "4px" }}>
                  This dispute has been resolved. Stakes have been distributed.
                </p>
              ) : (
                <p style={{ fontSize: "12px", color: "#555", marginTop: "4px" }}>
                  Result will be announced once all votes are collected or the round closes.
                  Blind voting. No tally will be shown before the verdict.
                </p>
              )}
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
  resultClientTag: { fontSize: "12px", color: "#a8f5d4", background: "rgba(168,245,212,0.1)", padding: "3px 8px", borderRadius: "6px", fontWeight: "600" },
  resultArtistTag: { fontSize: "12px", color: "#82b1ff", background: "rgba(130,177,255,0.1)", padding: "3px 8px", borderRadius: "6px", fontWeight: "600" },

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
  cidLink: { fontSize: "11px", color: "#a8f5d4", fontFamily: "monospace", textDecoration: "none", borderBottom: "1px dashed rgba(168,245,212,0.4)", transition: "color 0.2s, border-color 0.2s", cursor: "pointer", wordBreak: "break-all" },
  blindVotingReminder: { fontSize: "12px", color: "#EF9F27", marginTop: "10px", padding: "8px 12px", background: "rgba(239,159,39,0.06)", borderRadius: "6px" },

  // Watermarked image preview
  previewSection: { marginTop: "14px", padding: "14px", background: "rgba(168,245,212,0.03)", border: "1px solid rgba(168,245,212,0.12)", borderRadius: "10px" },
  previewLabel: { fontSize: "12px", fontWeight: "700", color: "#a8f5d4", letterSpacing: "0.03em", marginBottom: "10px" },
  previewLink: { display: "block", textDecoration: "none" },
  previewImg: { maxWidth: "100%", maxHeight: "400px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.08)", objectFit: "contain", display: "block", margin: "0 auto" },
  openFullBtn: { display: "block", width: "100%", padding: "9px", marginTop: "10px", background: "rgba(168,245,212,0.07)", border: "1px solid rgba(168,245,212,0.2)", borderRadius: "8px", color: "#a8f5d4", fontSize: "12px", textAlign: "center", textDecoration: "none", cursor: "pointer" },

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

  // Juror rules panel
  rulesPanel: { background: "rgba(168,245,212,0.04)", border: "1px solid rgba(168,245,212,0.18)", borderRadius: "12px", padding: "18px 22px", marginBottom: "20px" },
  rulesPanelHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" },
  rulesPanelTitle: { fontSize: "14px", fontWeight: "700", color: "#a8f5d4" },
  registeredBadge: { fontSize: "12px", color: "#a8f5d4", background: "rgba(168,245,212,0.08)", border: "1px solid rgba(168,245,212,0.25)", borderRadius: "20px", padding: "6px 14px", whiteSpace: "nowrap" },
  registerBtn: { padding: "9px 18px", background: "#a8f5d4", color: "#0d0d0f", border: "none", borderRadius: "8px", fontSize: "13px", fontWeight: "700", cursor: "pointer", whiteSpace: "nowrap" },
  rulesGrid: { display: "flex", gap: "12px" },
  ruleBlock: { flex: 1, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "10px", padding: "14px 16px" },
  ruleBlockHeader: { fontSize: "12px", fontWeight: "700", color: "#a8f5d4", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: "6px" },
  ruleBlockValue: { fontSize: "22px", fontWeight: "700", color: "#e8e6de", marginBottom: "4px" },
  ruleBlockCondition: { fontSize: "12px", color: "#888", marginBottom: "8px" },
  ruleBlockDetail: { fontSize: "11px", color: "#666", lineHeight: "1.7" },
  rulesNote: { fontSize: "12px", color: "#555", margin: "14px 0 0", lineHeight: "1.7" },
}
