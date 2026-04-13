// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ReviewerRegistry.sol";
import "./ProductMarket.sol";

/**
 * @title DisputeManager
 * @notice Manages the full lifecycle of commission disputes on the DeCommission platform.
 *
 * Dispute flow:
 *   1. ProductMarket.raiseDispute() → DisputeManager.openDispute()
 *      A random set of jurors is selected from ReviewerRegistry.
 *   2. Each assigned juror calls stakeToEnter() to lock their juror stake.
 *   3. Each staked juror calls castVote() within the 24-hour voting window.
 *   4. After the deadline, anyone may call settleDispute().
 *      - Majority wins; if tied, a new round begins with a fresh juror set.
 *      - Winning-side jurors: stake returned + share of prize pool.
 *      - Losing-side jurors: stake forfeited into prize pool.
 *      - Platform takes a small fee from the prize pool.
 *
 * Tier system (mirrors ProductMarket.sol thresholds):
 *   Tier 1 — Small:  price < 0.5 ETH  → 3 jurors, 0.03 ETH juror stake
 *   Tier 2 — Medium: 0.5–2 ETH        → 5 jurors, 0.08 ETH juror stake
 *   Tier 3 — Large:  price ≥ 2 ETH    → 7 jurors, 0.15 ETH juror stake
 */
contract DisputeManager {
    ReviewerRegistry public registry;
    ProductMarket    public market;

    // Voting window: jurors must vote within 24 hours of dispute opening
    uint256 public constant VOTING_PERIOD = 1 days;

    // ── Tier thresholds (must stay in sync with ProductMarket.sol) ─────────────
    uint256 public constant TIER1_THRESHOLD = 0.5 ether;
    uint256 public constant TIER2_THRESHOLD = 2   ether;

    // ── Juror counts per tier ──────────────────────────────────────────────────
    // Odd numbers ensure no ties within a single tier round (ties still possible
    // due to absent voters, so tie-breaking via re-vote is kept as a safeguard).
    uint256 public constant TIER1_REVIEWER_COUNT = 3;
    uint256 public constant TIER2_REVIEWER_COUNT = 5;
    uint256 public constant TIER3_REVIEWER_COUNT = 7;

    // ── Juror stakes per tier ──────────────────────────────────────────────────
    // Each assigned juror must stake this amount to participate. Incorrect votes
    // result in stake forfeiture; correct votes earn a proportional share of the pool.
    uint256 public constant TIER1_REVIEWER_STAKE = 0.03 ether;
    uint256 public constant TIER2_REVIEWER_STAKE = 0.08 ether;
    uint256 public constant TIER3_REVIEWER_STAKE = 0.15 ether;

    // ── Platform fee per tier (taken from the prize pool before juror payouts) ──
    uint256 public constant TIER1_PLATFORM_FEE = 0.01 ether;
    uint256 public constant TIER2_PLATFORM_FEE = 0.03 ether;
    uint256 public constant TIER3_PLATFORM_FEE = 0.06 ether;

    enum Vote { None, BuyerWins, SellerWins }

    struct ReviewerInfo {
        bool hasStaked;  // True after juror calls stakeToEnter()
        bool hasVoted;   // True after juror calls castVote()
        Vote vote;       // The juror's chosen side
    }

    struct Dispute {
        uint256 productId;
        address buyer;
        address seller;
        uint256 orderPrice;           // Commission price; used to derive tier parameters
        uint256 reviewerCount;        // Number of jurors for this dispute
        uint256 reviewerStake;        // Juror stake amount for this dispute
        uint256 platformFee;          // Platform fee for this dispute
        address[] assignedReviewers;
        mapping(address => ReviewerInfo) reviewerInfo;
        uint256 buyerVotes;
        uint256 sellerVotes;
        uint256 stakedReviewerCount;  // Number of jurors who have staked so far
        uint256 deadline;             // Voting deadline (block.timestamp + VOTING_PERIOD)
        bool    resolved;
        bool    buyerWon;
    }

    mapping(uint256 => Dispute) private disputes;
    mapping(address => uint256[]) private reviewerDisputes;
    mapping(address => uint256) public reviewerEarnings;

    // Accumulated platform fees (withdrawable by the platform owner)
    uint256 public platformBalance;

    event DisputeOpened(uint256 indexed productId, address[] reviewers);
    event ReviewerStaked(uint256 indexed productId, address indexed reviewer);
    event ReviewerWithdrew(uint256 indexed productId, address indexed reviewer);
    event VoteCast(uint256 indexed productId, address indexed reviewer, Vote vote);
    event DisputeResolved(uint256 indexed productId, bool buyerWon, uint256 buyerVotes, uint256 sellerVotes);
    event TieDetected(uint256 indexed productId);

    constructor(address _registry, address _market) {
        registry = ReviewerRegistry(_registry);
        market   = ProductMarket(payable(_market));
    }

    // ── Tier helper functions (also exposed to the frontend) ──────────────────

    function getTier(uint256 price) public pure returns (uint256) {
        if (price < TIER1_THRESHOLD) return 1;
        if (price < TIER2_THRESHOLD) return 2;
        return 3;
    }

    function getReviewerCountForPrice(uint256 price) public pure returns (uint256) {
        uint256 tier = getTier(price);
        if (tier == 1) return TIER1_REVIEWER_COUNT;
        if (tier == 2) return TIER2_REVIEWER_COUNT;
        return TIER3_REVIEWER_COUNT;
    }

    function getReviewerStakeForPrice(uint256 price) public pure returns (uint256) {
        uint256 tier = getTier(price);
        if (tier == 1) return TIER1_REVIEWER_STAKE;
        if (tier == 2) return TIER2_REVIEWER_STAKE;
        return TIER3_REVIEWER_STAKE;
    }

    function getPlatformFeeForPrice(uint256 price) public pure returns (uint256) {
        uint256 tier = getTier(price);
        if (tier == 1) return TIER1_PLATFORM_FEE;
        if (tier == 2) return TIER2_PLATFORM_FEE;
        return TIER3_PLATFORM_FEE;
    }

    // ── Dispute lifecycle ─────────────────────────────────────────────────────

    /**
     * @notice Opens a new dispute. Called exclusively by ProductMarket.raiseDispute().
     *         Randomly assigns jurors from ReviewerRegistry, excluding both parties.
     */
    function openDispute(
        uint256 productId,
        address buyer,
        address seller,
        bool    /* aiUsageAllowed — not applicable in this market context */,
        uint256 orderPrice
    ) external {
        require(msg.sender == address(market), "Only market contract");

        Dispute storage d = disputes[productId];
        d.productId     = productId;
        d.buyer         = buyer;
        d.seller        = seller;
        d.orderPrice    = orderPrice;
        d.reviewerCount = getReviewerCountForPrice(orderPrice);
        d.reviewerStake = getReviewerStakeForPrice(orderPrice);
        d.platformFee   = getPlatformFeeForPrice(orderPrice);
        d.deadline      = block.timestamp + VOTING_PERIOD;

        // Randomly assign jurors, excluding buyer and seller to prevent collusion
        d.assignedReviewers = registry.selectReviewers(buyer, seller, d.reviewerCount);
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            reviewerDisputes[d.assignedReviewers[i]].push(productId);
        }

        emit DisputeOpened(productId, d.assignedReviewers);
    }

    /**
     * @notice Assigned juror deposits their stake to gain voting rights.
     *         The stake is taken from juror's deposit balance and frozen in ProductMarket.
     */
    function stakeToEnter(uint256 productId) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp < d.deadline, "Voting period ended");

        bool isAssigned = false;
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            if (d.assignedReviewers[i] == msg.sender) { isAssigned = true; break; }
        }
        require(isAssigned, "Not assigned to this dispute");
        require(!d.reviewerInfo[msg.sender].hasStaked, "Already staked");

        // Move juror's deposit → frozen in ProductMarket; ETH sent to this contract
        market.jurorStakeFreeze(msg.sender, d.reviewerStake);

        d.reviewerInfo[msg.sender].hasStaked = true;
        d.stakedReviewerCount++;

        emit ReviewerStaked(productId, msg.sender);
    }

    /**
     * @notice Juror may withdraw their stake before casting a vote.
     *         Once a vote is submitted, withdrawal is no longer possible.
     */
    function withdrawStake(uint256 productId) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp < d.deadline, "Voting period ended");
        require(d.reviewerInfo[msg.sender].hasStaked, "Not staked");
        require(!d.reviewerInfo[msg.sender].hasVoted, "Already voted, cannot withdraw");

        d.reviewerInfo[msg.sender].hasStaked = false;
        d.stakedReviewerCount--;

        // Return ETH to ProductMarket and move frozen → deposit
        (bool sent, ) = address(market).call{value: d.reviewerStake}("");
        require(sent, "Transfer to PM failed");
        market.jurorStakeSettle(msg.sender, d.reviewerStake, d.reviewerStake);

        emit ReviewerWithdrew(productId, msg.sender);
    }

    /**
     * @notice Juror casts their vote. Requires having staked first.
     *         Vote options: 1 = BuyerWins, 2 = SellerWins.
     */
    function castVote(uint256 productId, Vote vote) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp < d.deadline, "Voting period ended");
        require(vote != Vote.None, "Invalid vote");
        require(d.reviewerInfo[msg.sender].hasStaked, "Must stake before voting");
        require(!d.reviewerInfo[msg.sender].hasVoted, "Already voted");

        d.reviewerInfo[msg.sender].vote    = vote;
        d.reviewerInfo[msg.sender].hasVoted = true;

        if (vote == Vote.BuyerWins) {
            d.buyerVotes++;
        } else {
            d.sellerVotes++;
        }

        emit VoteCast(productId, msg.sender, vote);

        // Auto-settle if all assigned reviewers have voted
        if (_allVoted(productId)) {
            _settle(productId);
        }
    }

    // ── Check whether every assigned reviewer has voted ───────────
    function _allVoted(uint256 productId) internal view returns (bool) {
        Dispute storage d = disputes[productId];
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            if (!d.reviewerInfo[d.assignedReviewers[i]].hasVoted) return false;
        }
        return true;
    }

    /**
     * @notice Settles the dispute after the voting deadline has passed.
     *         - If tied: resets votes and re-assigns jurors for a new round.
     *         - Otherwise: majority side wins.
     *           Prize pool = loser's dispute stake + stakes of incorrect-voting jurors.
     *           Platform fee is deducted, then remainder is split among correct-voting jurors.
     *           ProductMarket.resolveByDispute() is called to release the commission escrow.
     */
    function settleDispute(uint256 productId) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(
            block.timestamp >= d.deadline || _allVoted(productId),
            "Voting still ongoing"
        );
        _settle(productId);
    }

    function _settle(uint256 productId) internal {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");

        // ── Tie: start a new voting round ─────────────────────────────────────
        if (d.buyerVotes == d.sellerVotes) {
            d.deadline    = block.timestamp + VOTING_PERIOD;
            d.buyerVotes  = 0;
            d.sellerVotes = 0;

            // Refund staked-but-not-voted jurors: frozen → deposit via PM
            for (uint i = 0; i < d.assignedReviewers.length; i++) {
                address r = d.assignedReviewers[i];
                ReviewerInfo storage ri = d.reviewerInfo[r];
                if (ri.hasStaked && !ri.hasVoted) {
                    ri.hasStaked = false;
                    d.stakedReviewerCount--;
                    {
                        (bool s, ) = address(market).call{value: d.reviewerStake}("");
                        require(s, "Transfer to PM failed");
                    }
                    market.jurorStakeSettle(r, d.reviewerStake, d.reviewerStake);
                }
                ri.hasVoted = false;
                ri.vote     = Vote.None;
            }

            d.assignedReviewers = registry.selectReviewers(d.buyer, d.seller, d.reviewerCount);
            for (uint i = 0; i < d.assignedReviewers.length; i++) {
                reviewerDisputes[d.assignedReviewers[i]].push(productId);
            }

            emit TieDetected(productId);
            return;
        }

        // ── Clear majority: resolve ────────────────────────────────────────────
        bool buyerWon    = d.buyerVotes > d.sellerVotes;
        d.resolved       = true;
        d.buyerWon       = buyerWon;
        Vote winningVote = buyerWon ? Vote.BuyerWins : Vote.SellerWins;

        // ── Juror payout: all staked jurors' stakes pooled → split among correct voters
        uint256 correctVoterCount = 0;
        uint256 totalJurorPool    = 0;
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            ReviewerInfo storage ri = d.reviewerInfo[d.assignedReviewers[i]];
            if (ri.hasStaked) {
                totalJurorPool += d.reviewerStake;
                if (ri.hasVoted && ri.vote == winningVote) {
                    correctVoterCount++;
                }
            }
        }

        uint256 payoutPerCorrectVoter = (correctVoterCount > 0)
            ? totalJurorPool / correctVoterCount
            : 0;

        // Send total correct-voter payout ETH to ProductMarket in one batch
        uint256 totalJurorPayout = correctVoterCount * payoutPerCorrectVoter;
        if (totalJurorPayout > 0) {
            (bool s, ) = address(market).call{value: totalJurorPayout}("");
            require(s, "Transfer juror payouts to PM failed");
        }

        // Update frozen/deposit for each juror via ProductMarket
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            address r = d.assignedReviewers[i];
            ReviewerInfo storage ri = d.reviewerInfo[r];
            if (ri.hasStaked) {
                if (ri.hasVoted && ri.vote == winningVote) {
                    // Correct vote: frozen removed, deposit credited with pool share
                    uint256 reward = payoutPerCorrectVoter > d.reviewerStake
                        ? payoutPerCorrectVoter - d.reviewerStake : 0;
                    reviewerEarnings[r] += reward;
                    market.jurorStakeSettle(r, d.reviewerStake, payoutPerCorrectVoter);
                } else {
                    // Incorrect vote or staked-but-not-voted: frozen forfeited
                    market.jurorStakeSettle(r, d.reviewerStake, 0);
                }
            }
        }

        // ── Party dispute stakes: loser's stake → winner (minus platform fee)
        uint256 disputeStake = market.getDisputeStakeForPrice(d.orderPrice);
        uint256 actualPlatformFee = disputeStake >= d.platformFee ? d.platformFee : disputeStake;
        platformBalance += actualPlatformFee;
        uint256 winnerStakeReturn = 2 * disputeStake - actualPlatformFee;

        {
            (bool s, ) = address(market).call{value: winnerStakeReturn}("");
            require(s, "Failed to send stake to market");
        }

        uint256 buyerStakeReturn  = buyerWon ? winnerStakeReturn : 0;
        uint256 sellerStakeReturn = buyerWon ? 0 : winnerStakeReturn;

        market.resolveByDispute(productId, buyerWon, buyerStakeReturn, sellerStakeReturn);

        emit DisputeResolved(productId, buyerWon, d.buyerVotes, d.sellerVotes);
    }
    // ── 平台提款 ──────────────────────────────────────────────────
    // demo 用，实际应该加 owner 权限控制
    function withdrawPlatformFee(address to) external {
        uint256 amount = platformBalance;
        platformBalance = 0;
        payable(to).transfer(amount);
    }

    // ── View functions ────────────────────────────────────────────────────────

    struct DisputeView {
        uint256 productId;
        address buyer;
        address seller;
        uint256 orderPrice;
        uint256 reviewerCount;
        uint256 reviewerStake;
        uint256 buyerVotes;
        uint256 sellerVotes;
        uint256 deadline;
        bool    resolved;
        bool    buyerWon;
        uint8   myVote;
        bool    myHasStaked;
        bool    myHasVoted;
    }

    struct PartyDisputeView {
        uint256 productId;
        uint256 buyerVotes;
        uint256 sellerVotes;
        uint256 deadline;
        bool    resolved;
        bool    buyerWon;
    }

    /** @notice Returns full dispute details for all cases assigned to a juror. */
    function getReviewerDisputeDetails(address reviewer)
        external view returns (DisputeView[] memory)
    {
        uint256[] memory ids = reviewerDisputes[reviewer];
        DisputeView[] memory result = new DisputeView[](ids.length);
        for (uint i = 0; i < ids.length; i++) {
            Dispute storage d = disputes[ids[i]];
            ReviewerInfo storage ri = d.reviewerInfo[reviewer];
            result[i] = DisputeView({
                productId:    ids[i],
                buyer:        d.buyer,
                seller:       d.seller,
                orderPrice:   d.orderPrice,
                reviewerCount: d.reviewerCount,
                reviewerStake: d.reviewerStake,
                buyerVotes:   d.buyerVotes,
                sellerVotes:  d.sellerVotes,
                deadline:     d.deadline,
                resolved:     d.resolved,
                buyerWon:     d.buyerWon,
                myVote:       uint8(ri.vote),
                myHasStaked:  ri.hasStaked,
                myHasVoted:   ri.hasVoted
            });
        }
        return result;
    }

    /** @notice Returns dispute progress for a set of product IDs (used by both parties). */
    function getDisputesByParty(uint256[] calldata productIds)
        external view returns (PartyDisputeView[] memory)
    {
        PartyDisputeView[] memory result = new PartyDisputeView[](productIds.length);
        for (uint i = 0; i < productIds.length; i++) {
            Dispute storage d = disputes[productIds[i]];
            result[i] = PartyDisputeView({
                productId:  productIds[i],
                buyerVotes: d.buyerVotes,
                sellerVotes: d.sellerVotes,
                deadline:   d.deadline,
                resolved:   d.resolved,
                buyerWon:   d.buyerWon
            });
        }
        return result;
    }

    function getDisputesByReviewer(address reviewer)
        external view returns (uint256[] memory)
    {
        return reviewerDisputes[reviewer];
    }

    function getDisputeInfo(uint256 productId) external view returns (
        address[] memory assignedReviewers,
        uint256          reviewerStake,
        uint256          buyerVotes,
        uint256          sellerVotes,
        uint256          deadline,
        bool             resolved,
        bool             buyerWon
    ) {
        Dispute storage d = disputes[productId];
        return (
            d.assignedReviewers,
            d.reviewerStake,
            d.buyerVotes,
            d.sellerVotes,
            d.deadline,
            d.resolved,
            d.buyerWon
        );
    }

    function getReviewerVote(uint256 productId, address reviewer)
        external view returns (Vote)
    {
        return disputes[productId].reviewerInfo[reviewer].vote;
    }

    function getReviewerStakeStatus(uint256 productId, address reviewer)
        external view returns (bool hasStaked, bool hasVoted)
    {
        ReviewerInfo storage ri = disputes[productId].reviewerInfo[reviewer];
        return (ri.hasStaked, ri.hasVoted);
    }

    receive() external payable {}
}
