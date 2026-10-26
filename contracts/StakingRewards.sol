// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title StakingRewards
/// @notice Эпохальный стейкинг DROP-токена без оунера и без привилегий.
///         Эпоха = сутки. Прибыль делится пропорционально между адресами,
///         подтверждёнными на текущую эпоху. Подтверждение делается заранее,
///         в течение текущей эпохи (без задержек на границе периода).
///         Не подтвердился — автоматически выпал из начисления со следующей
///         эпохи, тело стейка при этом остаётся на месте до явного withdraw().
///
///         donate() — permissionless: пополнить фонд распределения может
///         игровой контракт, байбэк-контракт при переполнении резерва,
///         или любой желающий вручную.
contract StakingRewards is ReentrancyGuard {
    IERC20 public immutable token;

    uint256 public constant EPOCH = 1 days;
    uint256 public immutable startTime;

    uint256 private constant PRECISION = 1e18;
    uint256 public accRewardPerShare;

    // Не удалось разделить (totalConfirmedStake == 0 на момент donate) —
    // ждёт первого, кто появится в подтверждённом пуле.
    uint256 public pendingRewards;

    uint256 public totalStaked;         // весь застейканный объём
    uint256 public totalConfirmedStake; // объём, реально участвующий в начислении текущей эпохи

    struct Staker {
        uint256 amount;              // тело стейка
        uint256 confirmedUntilEpoch; // до какой эпохи включительно подтверждено участие
        uint256 rewardWeight;        // вес, реально учтённый в totalConfirmedStake (0 или amount)
        uint256 rewardDebt;          // rewardWeight * accRewardPerShare на момент последнего settle
        uint256 accruedReward;       // накопленная, но ещё не выплаченная прибыль
    }

    mapping(address => Staker) public stakers;

    event Staked(address indexed user, uint256 amount);
    event Confirmed(address indexed user, uint256 untilEpoch);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardClaimed(address indexed user, uint256 amount);
    event RewardDonated(address indexed from, uint256 amount, bool bufferedNoStakers);

    constructor(address tokenAddress) {
        token = IERC20(tokenAddress);
        startTime = block.timestamp;
    }

    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - startTime) / EPOCH;
    }

    /// @notice Пополнить фонд распределения. Вызвать может кто угодно.
    function donate() external payable nonReentrant {
        require(msg.value > 0, "StakingRewards: zero donation");

        if (totalConfirmedStake == 0) {
            pendingRewards += msg.value;
            emit RewardDonated(msg.sender, msg.value, true);
            return;
        }

        uint256 toDistribute = msg.value + pendingRewards;
        pendingRewards = 0;
        accRewardPerShare += (toDistribute * PRECISION) / totalConfirmedStake;
        emit RewardDonated(msg.sender, msg.value, false);
    }

    /// @notice Застейкать токены. Сразу подтверждает участие в текущей эпохе.
    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "StakingRewards: zero amount");

        Staker storage s = stakers[msg.sender];
        _settle(s);

        require(token.transferFrom(msg.sender, address(this), amount), "transferFrom failed");

        s.amount += amount;
        totalStaked += amount;
        _syncWeight(s, currentEpoch());

        emit Staked(msg.sender, amount);
    }

    /// @notice Подтвердить участие в следующей эпохе. Можно вызывать в любой
    ///         момент текущей эпохи, пока пользователь ещё активен.
    function confirmNextEpoch() external nonReentrant {
        Staker storage s = stakers[msg.sender];
        require(s.amount > 0, "StakingRewards: not staked");
        require(s.confirmedUntilEpoch >= currentEpoch(), "StakingRewards: dropped out, restake");

        _settle(s);
        s.confirmedUntilEpoch += 1;
        _syncWeight(s, s.confirmedUntilEpoch);
    }

    /// @notice Забрать накопленную прибыль без вывода тела стейка.
    function claim() external nonReentrant {
        Staker storage s = stakers[msg.sender];
        _settle(s);

        uint256 reward = s.accruedReward;
        require(reward > 0, "StakingRewards: nothing to claim");
        s.accruedReward = 0;

        (bool sent, ) = payable(msg.sender).call{value: reward}("");
        require(sent, "StakingRewards: payout failed");

        emit RewardClaimed(msg.sender, reward);
    }

    /// @notice Вывести часть или весь стейк (и заодно накопленную прибыль).
    function withdraw(uint256 amount) external nonReentrant {
        Staker storage s = stakers[msg.sender];
        require(amount > 0 && amount <= s.amount, "StakingRewards: bad amount");

        _settle(s);

        s.amount -= amount;
        totalStaked -= amount;
        _syncWeight(s, s.confirmedUntilEpoch);

        require(token.transfer(msg.sender, amount), "transfer failed");

        uint256 reward = s.accruedReward;
        if (reward > 0) {
            s.accruedReward = 0;
            (bool sent, ) = payable(msg.sender).call{value: reward}("");
            require(sent, "StakingRewards: payout failed");
            emit RewardClaimed(msg.sender, reward);
        }

        emit Withdrawn(msg.sender, amount);
    }

    function pendingReward(address user) external view returns (uint256) {
        Staker memory s = stakers[user];
        uint256 weight = s.confirmedUntilEpoch >= currentEpoch() ? s.rewardWeight : 0;
        uint256 accumulated = (weight * accRewardPerShare) / PRECISION;
        return s.accruedReward + accumulated - s.rewardDebt;
    }

    // --- internal ---

    /// @dev Фиксирует прибыль, накопленную по текущему rewardWeight, и лениво
    ///      обнуляет вес, если эпоха подтверждения истекла и это ещё не учтено.
    function _settle(Staker storage s) internal {
        uint256 accumulated = (s.rewardWeight * accRewardPerShare) / PRECISION;
        s.accruedReward += accumulated - s.rewardDebt;

        if (s.confirmedUntilEpoch < currentEpoch() && s.rewardWeight > 0) {
            totalConfirmedStake -= s.rewardWeight;
            s.rewardWeight = 0;
        }

        s.rewardDebt = (s.rewardWeight * accRewardPerShare) / PRECISION;
    }

    /// @dev Синхронизирует rewardWeight с amount, если пользователь подтверждён
    ///      на currentEpoch (или на будущую эпоху через confirmNextEpoch).
    ///      Вызывать сразу после _settle().
    function _syncWeight(Staker storage s, uint256 confirmedUntil) internal {
        s.confirmedUntilEpoch = confirmedUntil;
        bool shouldBeActive = confirmedUntil >= currentEpoch();
        uint256 newWeight = shouldBeActive ? s.amount : 0;

        if (newWeight != s.rewardWeight) {
            totalConfirmedStake = totalConfirmedStake + newWeight - s.rewardWeight;
            s.rewardWeight = newWeight;
            s.rewardDebt = (newWeight * accRewardPerShare) / PRECISION;
        }

        emit Confirmed(msg.sender, confirmedUntil);
    }

    receive() external payable {
        revert("StakingRewards: use donate()");
    }
}
