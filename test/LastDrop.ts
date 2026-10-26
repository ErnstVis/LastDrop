import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

// Хелпер: продвинуть время сети вперёд и замайнить блок,
// чтобы deadline контракта реально считался истёкшим.
async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("LastDrop", function () {
  const BET_AMOUNT = ethers.parseEther("10");
  const BET_INTERVAL = 300; // 5 минут, дефолт из контракта

  // Разворачиваем свежий контракт перед каждым тестом,
  // чтобы тесты не влияли друг на друга.
  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();

    // Один контракт — он же игра, он же токен DROP
    const lastDrop = await ethers.deployContract("LastDrop");

    return { lastDrop, owner, alice, bob };
  }

  describe("Начальное состояние", function () {
    it("выставляет дефолтные параметры и владельца", async function () {
      const { lastDrop, owner } = await deployFixture();

      expect(await lastDrop.owner()).to.equal(owner.address);
      expect(await lastDrop.betAmount()).to.equal(BET_AMOUNT);
      expect(await lastDrop.betInterval()).to.equal(BET_INTERVAL);
      expect(await lastDrop.bank()).to.equal(0);
      expect(await lastDrop.fee()).to.equal(0);
      expect(await lastDrop.lastBettor()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("bet()", function () {
    it("отклоняет ставку неверного размера", async function () {
      const { lastDrop, alice } = await deployFixture();

      await expect(
        lastDrop.connect(alice).bet({ value: ethers.parseEther("5") })
      ).to.be.revertedWith("LastDrop: wrong bet amount");
    });

    it("принимает первую ставку, обновляет lastBettor и bank с учётом fee", async function () {
      const { lastDrop, alice } = await deployFixture();

      const tx = await lastDrop.connect(alice).bet({ value: BET_AMOUNT });
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      expect(await lastDrop.lastBettor()).to.equal(alice.address);

      const expectedFee = BET_AMOUNT / 10n;
      const expectedBank = BET_AMOUNT - expectedFee;
      expect(await lastDrop.fee()).to.equal(expectedFee);
      expect(await lastDrop.bank()).to.equal(expectedBank);

      // deadline должен быть выставлен на block.timestamp + betInterval этой транзакции
      expect(await lastDrop.deadline()).to.equal(
        BigInt(block!.timestamp) + BigInt(BET_INTERVAL)
      );

      await expect(tx)
        .to.emit(lastDrop, "BetPlaced")
        .withArgs(alice.address, await lastDrop.deadline());
    });

    it("копит fee и bank корректно на нескольких ставках подряд", async function () {
      const { lastDrop, alice, bob } = await deployFixture();

      // Ставим трижды подряд, не давая таймеру истечь между ставками
      await lastDrop.connect(alice).bet({ value: BET_AMOUNT });
      await lastDrop.connect(bob).bet({ value: BET_AMOUNT });
      await lastDrop.connect(alice).bet({ value: BET_AMOUNT });

      const expectedFeePerBet = BET_AMOUNT / 10n;
      const expectedBankPerBet = BET_AMOUNT - expectedFeePerBet;

      // Это как раз тест на баг из черновика: fee и bank должны расти
      // РОВНО на одну и ту же величину при каждой ставке
      expect(await lastDrop.fee()).to.equal(expectedFeePerBet * 3n);
      expect(await lastDrop.bank()).to.equal(expectedBankPerBet * 3n);
      expect(await lastDrop.lastBettor()).to.equal(alice.address);
    });

    it("после истечения таймера начисляет банк предыдущему победителю и открывает новый раунд", async function () {
      const { lastDrop, alice, bob } = await deployFixture();

      await lastDrop.connect(alice).bet({ value: BET_AMOUNT });
      const expectedPayout = BET_AMOUNT - BET_AMOUNT / 10n;

      // Таймер истёк, банк никто не забирал
      await increaseTime(BET_INTERVAL + 1);

      const tx = await lastDrop.connect(bob).bet({ value: BET_AMOUNT });

      // Alice должна получить payout не на кошелёк, а в pendingWithdrawals
      expect(await lastDrop.pendingWithdrawals(alice.address)).to.equal(
        expectedPayout
      );
      await expect(tx)
        .to.emit(lastDrop, "BankClaimed")
        .withArgs(alice.address, expectedPayout);

      // Новый раунд уже открыт ставкой Боба: bank содержит только его вклад
      expect(await lastDrop.lastBettor()).to.equal(bob.address);
      expect(await lastDrop.bank()).to.equal(BET_AMOUNT - BET_AMOUNT / 10n);
    });

    it("не позволяет ставить в момент, когда bank уже пуст и раунд не начинался (edge case деплоя)", async function () {
      // На старте deadline = timestamp деплоя, значит deadline < block.timestamp
      // сразу истинно, но bank == 0 — начисления быть не должно.
      const { lastDrop, alice } = await deployFixture();

      const tx = await lastDrop.connect(alice).bet({ value: BET_AMOUNT });

      await expect(tx).to.not.emit(lastDrop, "BankClaimed");
      expect(await lastDrop.pendingWithdrawals(alice.address)).to.equal(0);
    });
  });

  describe("withdraw()", function () {
    it("позволяет забрать начисленный банк и обнуляет запись", async function () {
      const { lastDrop, alice, bob } = await deployFixture();

      await lastDrop.connect(alice).bet({ value: BET_AMOUNT });
      const expectedPayout = BET_AMOUNT - BET_AMOUNT / 10n;

      await increaseTime(BET_INTERVAL + 1);
      await lastDrop.connect(bob).bet({ value: BET_AMOUNT });

      const balanceBefore = await ethers.provider.getBalance(alice.address);
      const tx = await lastDrop.connect(alice).withdraw();
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(alice.address);

      // Баланс вырос ровно на payout за вычетом газа, потраченного на сам withdraw
      expect(balanceAfter).to.equal(balanceBefore + expectedPayout - gasCost);
      expect(await lastDrop.pendingWithdrawals(alice.address)).to.equal(0);

      await expect(tx)
        .to.emit(lastDrop, "Withdrawn")
        .withArgs(alice.address, expectedPayout);
    });

    it("реверт при попытке вывести без начисленного баланса", async function () {
      const { lastDrop, alice } = await deployFixture();

      await expect(lastDrop.connect(alice).withdraw()).to.be.revertedWith(
        "LastDrop: nothing to withdraw"
      );
    });

    it("реверт при повторном выводе (защита от двойного списания)", async function () {
      const { lastDrop, alice, bob } = await deployFixture();

      await lastDrop.connect(alice).bet({ value: BET_AMOUNT });
      await increaseTime(BET_INTERVAL + 1);
      await lastDrop.connect(bob).bet({ value: BET_AMOUNT });

      await lastDrop.connect(alice).withdraw();

      await expect(lastDrop.connect(alice).withdraw()).to.be.revertedWith(
        "LastDrop: nothing to withdraw"
      );
    });
  });

  describe("withdrawFee()", function () {
    it("позволяет владельцу вывести накопленную комиссию", async function () {
      const { lastDrop, owner, alice } = await deployFixture();

      await lastDrop.connect(alice).bet({ value: BET_AMOUNT });
      const expectedFee = BET_AMOUNT / 10n;

      const balanceBefore = await ethers.provider.getBalance(owner.address);
      const tx = await lastDrop.connect(owner).withdrawFee();
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(owner.address);

      expect(balanceAfter).to.equal(balanceBefore + expectedFee - gasCost);
      expect(await lastDrop.fee()).to.equal(0);
    });

    it("реверт при вызове не владельцем", async function () {
      const { lastDrop, alice } = await deployFixture();

      await lastDrop.connect(alice).bet({ value: BET_AMOUNT });

      await expect(lastDrop.connect(alice).withdrawFee()).to.be.revertedWith(
        "LastDrop: not owner"
      );
    });

    it("реверт, если комиссия ещё не накопилась", async function () {
      const { lastDrop, owner } = await deployFixture();

      await expect(lastDrop.connect(owner).withdrawFee()).to.be.revertedWith(
        "LastDrop: nothing to withdraw"
      );
    });
  });

  describe("Настройки владельца", function () {
    it("owner может менять betAmount и betInterval", async function () {
      const { lastDrop, owner } = await deployFixture();

      const newAmount = ethers.parseEther("20");
      const newInterval = 600;

      await lastDrop.connect(owner).setBetAmount(newAmount);
      await lastDrop.connect(owner).setBetInterval(newInterval);

      expect(await lastDrop.betAmount()).to.equal(newAmount);
      expect(await lastDrop.betInterval()).to.equal(newInterval);
    });

    it("реверт при попытке смены параметров не владельцем", async function () {
      const { lastDrop, alice } = await deployFixture();

      await expect(
        lastDrop.connect(alice).setBetAmount(ethers.parseEther("20"))
      ).to.be.revertedWith("LastDrop: not owner");

      await expect(
        lastDrop.connect(alice).setBetInterval(600)
      ).to.be.revertedWith("LastDrop: not owner");
    });
  });

  describe("Бонусный минтинг токена (DROP)", function () {
    it("игровой контракт сам является токеном DROP", async function () {
      const { lastDrop } = await deployFixture();

      // Эти функции LastDrop унаследовал от ERC20
      expect(await lastDrop.name()).to.equal("LastDrop Token");
      expect(await lastDrop.symbol()).to.equal("DROP");
      expect(await lastDrop.decimals()).to.equal(18);
      expect(await lastDrop.totalSupply()).to.equal(0);
    });

    it("не имеет публичной функции mint — минтить в обход игры нельзя", async function () {
      const { lastDrop } = await deployFixture();

      // _mint — internal, поэтому её нет в ABI контракта
      expect(lastDrop.interface.hasFunction("mint")).to.equal(false);
      expect(lastDrop.interface.hasFunction("_mint")).to.equal(false);
    });

    it("начисляет 1 DROP игроку при ставке, пока bank ниже порога", async function () {
      const { lastDrop, alice } = await deployFixture();

      const tx = await lastDrop.connect(alice).bet({ value: BET_AMOUNT });

      expect(await lastDrop.balanceOf(alice.address)).to.equal(
        ethers.parseEther("1")
      );
      expect(await lastDrop.totalSupply()).to.equal(ethers.parseEther("1"));

      await expect(tx)
        .to.emit(lastDrop, "BonusMinted")
        .withArgs(alice.address, ethers.parseEther("1"));
    });

    it("перестаёт начислять бонус, как только банк раунда достигает порога", async function () {
      const { lastDrop, owner, alice, bob } = await deployFixture();

      // Подгоняем betAmount так, чтобы порог 1000 ether пробивался ровно за 2 ставки
      const bigBet = ethers.parseEther("1000");
      await lastDrop.connect(owner).setBetAmount(bigBet);

      // 1-я ставка: bank станет 900 ether (после 10% fee) — ниже порога, бонус есть
      await lastDrop.connect(alice).bet({ value: bigBet });
      expect(await lastDrop.balanceOf(alice.address)).to.equal(
        ethers.parseEther("1")
      );

      // 2-я ставка (тот же раунд, таймер не истёк): bank станет 1800 ether — порог пробит,
      // для этой ставки бонуса быть не должно
      const tx = await lastDrop.connect(bob).bet({ value: bigBet });

      expect(await lastDrop.balanceOf(bob.address)).to.equal(0);
      await expect(tx).to.not.emit(lastDrop, "BonusMinted");
    });

    it("возобновляет начисление бонуса в новом раунде после сброса банка", async function () {
      const { lastDrop, alice, bob } = await deployFixture();

      // Раунд 1: Алиса ставит и получает бонус
      await lastDrop.connect(alice).bet({ value: BET_AMOUNT });
      expect(await lastDrop.balanceOf(alice.address)).to.equal(
        ethers.parseEther("1")
      );

      // Таймер истекает — банк выплачивается Алисе, раунд закрывается
      await increaseTime(BET_INTERVAL + 1);

      // Раунд 2: ставка Боба открывает новый раунд с чистым bank — бонус снова доступен
      const tx = await lastDrop.connect(bob).bet({ value: BET_AMOUNT });

      expect(await lastDrop.balanceOf(bob.address)).to.equal(
        ethers.parseEther("1")
      );
      await expect(tx)
        .to.emit(lastDrop, "BonusMinted")
        .withArgs(bob.address, ethers.parseEther("1"));
    });

    it("константы BONUS_AMOUNT и BANK_THRESHOLD выставлены корректно", async function () {
      const { lastDrop } = await deployFixture();

      expect(await lastDrop.BONUS_AMOUNT()).to.equal(ethers.parseEther("1"));
      expect(await lastDrop.BANK_THRESHOLD()).to.equal(
        ethers.parseEther("1000")
      );
    });
  });
});