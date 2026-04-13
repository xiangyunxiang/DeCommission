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
     *         The stake is held until the dispute is settled.
     */
    function stakeToEnter(uint256 productId) external payable {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp < d.deadline, "Voting period ended");
        require(msg.value == d.reviewerStake, "Incorrect stake amount");

        bool isAssigned = false;
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            if (d.assignedReviewers[i] == msg.sender) { isAssigned = true; break; }
        }
        require(isAssigned, "Not assigned to this dispute");
        require(!d.reviewerInfo[msg.sender].hasStaked, "Already staked");

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

        payable(msg.sender).transfer(d.reviewerStake);
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
        require(block.timestamp >= d.deadline, "Voting still ongoing");

        // ── Tie: start a new voting round ─────────────────────────────────────
        if (d.buyerVotes == d.sellerVotes) {
            d.deadline    = block.timestamp + VOTING_PERIOD;
            d.buyerVotes  = 0;
            d.sellerVotes = 0;

            // Refund staked-but-not-voted jurors; carry over voted jurors' stakes
            for (uint i = 0; i < d.assignedReviewers.length; i++) {
                address r = d.assignedReviewers[i];
                ReviewerInfo storage ri = d.reviewerInfo[r];
                if (ri.hasStaked && !ri.hasVoted) {
                    ri.hasStaked = false;
                    d.stakedReviewerCount--;
                    payable(r).transfer(d.reviewerStake);
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

        // Prize pool starts with the losing party's dispute stake
        uint256 disputeStake = market.getDisputeStakeForPrice(d.orderPrice);
        uint256 prizePool    = disputeStake;

        // Incorrect-voting jurors' stakes are also forfeited into the prize pool
        uint256 correctVoterCount = 0;
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            address r = d.assignedReviewers[i];
            ReviewerInfo storage ri = d.reviewerInfo[r];
            if (ri.hasStaked && ri.hasVoted) {
                if (ri.vote == winningVote) {
                    correctVoterCount++;
                } else {
                    prizePool += d.reviewerStake;
                }
            }
        }

        // Deduct platform fee
        uint256 actualPlatformFee = prizePool >= d.platformFee ? d.platformFee : prizePool;
        platformBalance  += actualPlatformFee;
        uint256 remaining = prizePool - actualPlatformFee;

        // Reward per correct-voting juror
        uint256 rewardPerCorrectVoter = (correctVoterCount > 0)
            ? remaining / correctVoterCount
            : 0;

        // Distribute juror payouts
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            address r = d.assignedReviewers[i];
            ReviewerInfo storage ri = d.reviewerInfo[r];
            if (ri.hasStaked) {
                if (ri.hasVoted && ri.vote == winningVote) {
                    // Correct vote: stake returned + reward share
                    uint256 payout = d.reviewerStake + rewardPerCorrectVoter;
                    reviewerEarnings[r] += rewardPerCorrectVoter;
                    payable(r).transfer(payout);
                } else if (!ri.hasVoted) {
                    // Staked but did not vote: stake returned, no reward
                    payable(r).transfer(d.reviewerStake);
                }
                // Incorrect vote: stake forfeited (already added to prizePool above)
            }
        }

        // Send the winning party's returned stake to ProductMarket, which will
        // bundle it with the commission price and pay the winner in one transfer.
        (bool sent, ) = address(market).call{value: disputeStake}("");
        require(sent, "Failed to send stake to market");

        uint256 buyerStakeReturn  = buyerWon ? disputeStake : 0;
        uint256 sellerStakeReturn = buyerWon ? 0 : disputeStake;

        market.resolveByDispute(productId, buyerWon, buyerStakeReturn, sellerStakeReturn);

        emit DisputeResolved(productId, buyerWon, d.buyerVotes, d.sellerVotes);
    }

    // ── Platform fee withdrawal (add ownership control before production) ─────
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
