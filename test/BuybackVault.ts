import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

describe("BuybackVault", function () {
  const BET_AMOUNT = ethers.parseEther("10");

  // Пока контракты не сшиты в монолит, разворачиваем три отдельно:
  // игра (она же токен DROP) → стейкинг → резерв.
  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();

    const lastDrop = await ethers.deployContract("LastDrop");
    const staking = await ethers.deployContract("StakingRewards", [
      await lastDrop.getAddress(),
    ]);
    const vault = await ethers.deployContract("BuybackVault", [
      await lastDrop.getAddress(),
      await staking.getAddress(),
    ]);

    return { lastDrop, staking, vault, owner, alice, bob };
  }

  describe("Потолок обеспечения", function () {
    it("1 DROP обеспечен максимум 10 нативных монет", async function () {
      const { vault } = await deployFixture();

      expect(await vault.NATIVE_PER_TOKEN_MAX()).to.equal(
        ethers.parseEther("10")
      );
    });

    it("maxReserve() = 0, пока токены не выпущены", async function () {
      const { vault } = await deployFixture();

      expect(await vault.maxReserve()).to.equal(0n);
    });

    it("maxReserve() = 10 × эмиссия", async function () {
      const { lastDrop, vault, alice, bob } = await deployFixture();

      // Каждая ставка ниже порога банка выпускает 1 DROP
      await lastDrop.connect(alice).bet({ value: BET_AMOUNT });
      await lastDrop.connect(bob).bet({ value: BET_AMOUNT });

      expect(await lastDrop.totalSupply()).to.equal(ethers.parseEther("2"));
      expect(await vault.maxReserve()).to.equal(ethers.parseEther("20"));
    });
  });

  describe("fund()", function () {
    it("принимает в резерв всё, пока потолок не достигнут", async function () {
      const { lastDrop, vault, owner, alice } = await deployFixture();
      await lastDrop.connect(alice).bet({ value: BET_AMOUNT }); // 1 DROP → потолок 10

      const amount = ethers.parseEther("4");
      await expect(vault.connect(owner).fund({ value: amount }))
        .to.emit(vault, "ReserveFunded")
        .withArgs(owner.address, amount, 0n);

      expect(await vault.reserveBalance()).to.equal(amount);
    });

    it("излишек сверх потолка уходит в StakingRewards", async function () {
      const { lastDrop, staking, vault, owner, alice } = await deployFixture();
      await lastDrop.connect(alice).bet({ value: BET_AMOUNT }); // 1 DROP → потолок 10

      const amount = ethers.parseEther("15");
      const overflow = ethers.parseEther("5");

      await expect(vault.connect(owner).fund({ value: amount }))
        .to.emit(vault, "ReserveFunded")
        .withArgs(owner.address, amount, overflow);

      expect(await vault.reserveBalance()).to.equal(ethers.parseEther("10"));
      // Стейкеров нет — излишек ждёт в буфере стейкинга
      expect(await staking.pendingRewards()).to.equal(overflow);
    });

    it("при полном резерве весь платёж уходит стейкингу, без реверта", async function () {
      const { lastDrop, staking, vault, alice } = await deployFixture();
      await lastDrop.connect(alice).bet({ value: BET_AMOUNT });
      await vault.fund({ value: ethers.parseEther("10") }); // резерв полон

      const amount = ethers.parseEther("3");
      await vault.fund({ value: amount });

      expect(await vault.reserveBalance()).to.equal(ethers.parseEther("10"));
      expect(await staking.pendingRewards()).to.equal(amount);
    });
  });

  describe("redemptionRate()", function () {
    it("при полном обеспечении курс почти 10 за 1 DROP (минус виртуальный оффсет)", async function () {
      const { lastDrop, vault, alice } = await deployFixture();
      await lastDrop.connect(alice).bet({ value: BET_AMOUNT });
      await vault.fund({ value: ethers.parseEther("10") });

      const rate = await vault.redemptionRate();
      // VIRTUAL_OFFSET = 1000 wei к знаменателю → отклонение ничтожное
      expect(rate).to.be.lessThan(ethers.parseEther("10"));
      expect(rate).to.be.greaterThan(ethers.parseEther("9.9999"));
    });
  });
});
