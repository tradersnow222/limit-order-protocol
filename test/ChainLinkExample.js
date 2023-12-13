const { expect } = require('@1inch/solidity-utils');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { ether } = require('./helpers/utils');
const { signOrder, buildOrder, buildTakerTraits } = require('./helpers/orderUtils');
const { deploySwapTokens } = require('./helpers/fixtures');
const { ethers } = require('hardhat');

function buildSinglePriceCalldata ({ chainlinkCalcAddress, oracleAddress, spread, inverse = false }) {
    return ethers.utils.solidityPack(
        ['address', 'bytes1', 'address', 'uint256'],
        [chainlinkCalcAddress, inverse ? 0x80 : 0, oracleAddress, spread],
    );
}

function buildDoublePriceCalldata ({ chainlinkCalcAddress, oracleAddress1, oracleAddress2, decimalsScale, spread }) {
    return ethers.utils.solidityPack(
        ['address', 'bytes1', 'address', 'address', 'int256', 'uint256'],
        [chainlinkCalcAddress, 0x40, oracleAddress1, oracleAddress2, decimalsScale, spread],
    );
}

describe('ChainLinkExample', function () {
    let addr, addr1;

    before(async function () {
        [addr, addr1] = await ethers.getSigners();
    });

    async function deployContractsAndInit () {
        const { dai, weth, inch, swap, chainId } = await deploySwapTokens();

        await dai.mint(addr.address, ether('1000000'));
        await weth.deposit({ value: ether('100') });
        await inch.mint(addr.address, ether('1000000'));
        await dai.mint(addr1.address, ether('1000000'));
        await weth.connect(addr1).deposit({ value: ether('100') });
        await inch.mint(addr1.address, ether('1000000'));

        await dai.approve(swap.address, ether('1000000'));
        await weth.approve(swap.address, ether('1000000'));
        await inch.approve(swap.address, ether('1000000'));
        await dai.connect(addr1).approve(swap.address, ether('1000000'));
        await weth.connect(addr1).approve(swap.address, ether('1000000'));
        await inch.connect(addr1).approve(swap.address, ether('1000000'));

        const ChainlinkCalculator = await ethers.getContractFactory('ChainlinkCalculator');
        const chainlink = await ChainlinkCalculator.deploy();
        await chainlink.deployed();

        const AggregatorMock = await ethers.getContractFactory('AggregatorMock');
        const daiOracle = await AggregatorMock.deploy(ether('0.00025'));
        await daiOracle.deployed();
        const inchOracle = await AggregatorMock.deploy('1577615249227853');
        await inchOracle.deployed();

        return { dai, weth, inch, swap, chainId, chainlink, daiOracle, inchOracle };
    };

    it('eth -> dai chainlink+eps order', async function () {
        const { dai, weth, swap, chainId, chainlink, daiOracle } = await loadFixture(deployContractsAndInit);

        const chainlinkCalcAddress = chainlink.address;
        const oracleAddress = daiOracle.address;
        // chainlink rate is 1 eth = 4000 dai
        const order = buildOrder(
            {
                makerAsset: weth.address,
                takerAsset: dai.address,
                makingAmount: ether('1').toString(),
                takingAmount: ether('4000').toString(),
                maker: addr1.address,
            },
            {
                makingAmountData: buildSinglePriceCalldata({ chainlinkCalcAddress, oracleAddress, spread: '990000000' }), // maker offset is 0.99
                takingAmountData: buildSinglePriceCalldata({ chainlinkCalcAddress, oracleAddress, spread: '1010000000', inverse: true }), // taker offset is 1.01
            },
        );
        const signature = await signOrder(order, chainId, swap.address, addr1);

        const { r, _vs: vs } = ethers.utils.splitSignature(signature);
        // taking threshold = 4000 + 1% + eps
        const takerTraits = buildTakerTraits({
            extension: order.extension,
            minReturn: ether('0.99'),
        });
        const fillTx = swap.fillOrderArgs(order, r, vs, ether('4000'), takerTraits.traits, takerTraits.args);
        await expect(fillTx).to.changeTokenBalances(dai, [addr, addr1], [ether('-4000'), ether('4000')]);
        await expect(fillTx).to.changeTokenBalances(weth, [addr, addr1], [ether('0.99'), ether('-0.99')]);
    });

    it('dai -> eth chainlink+eps order', async function () {
        const { dai, weth, swap, chainId, chainlink, daiOracle } = await loadFixture(deployContractsAndInit);

        const chainlinkCalcAddress = chainlink.address;
        const oracleAddress = daiOracle.address;
        // chainlink rate is 1 eth = 4000 dai
        const order = buildOrder(
            {
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: ether('4000').toString(),
                takingAmount: ether('1').toString(),
                maker: addr1.address,
            },
            {
                makingAmountData: buildSinglePriceCalldata({ chainlinkCalcAddress, oracleAddress, spread: '990000000', inverse: true }), // maker offset is 0.99
                takingAmountData: buildSinglePriceCalldata({ chainlinkCalcAddress, oracleAddress, spread: '1010000000' }), // taker offset is 1.01
            },
        );
        const signature = await signOrder(order, chainId, swap.address, addr1);

        const { r, _vs: vs } = ethers.utils.splitSignature(signature);
        // taking threshold = 1 eth + 1% + eps
        const takerTraits = buildTakerTraits({
            makingAmount: true,
            extension: order.extension,
            minReturn: ether('1.01'),
        });
        const fillTx = swap.fillOrderArgs(order, r, vs, ether('4000'), takerTraits.traits, takerTraits.args);
        await expect(fillTx).to.changeTokenBalances(dai, [addr, addr1], [ether('4000'), ether('-4000')]);
        await expect(fillTx).to.changeTokenBalances(weth, [addr, addr1], [ether('-1.01'), ether('1.01')]);
    });

    it('dai -> 1inch chainlink+eps order (check takingAmountData)', async function () {
        const { dai, inch, swap, chainId, chainlink, daiOracle, inchOracle } = await loadFixture(deployContractsAndInit);

        const chainlinkCalcAddress = chainlink.address;
        const oracleAddress1 = inchOracle.address;
        const oracleAddress2 = daiOracle.address;
        const makingAmount = ether('100');
        const takingAmount = ether('632');
        const decimalsScale = '0';
        const takingSpread = 1010000000n; // taker offset is 1.01
        const order = buildOrder(
            {
                makerAsset: inch.address,
                takerAsset: dai.address,
                makingAmount,
                takingAmount,
                maker: addr1.address,
            },
            {
                makingAmountData: buildDoublePriceCalldata(
                    { chainlinkCalcAddress, oracleAddress1: oracleAddress2, oracleAddress2: oracleAddress1, decimalsScale, spread: '990000000' }, // maker offset is 0.99
                ),
                takingAmountData: buildDoublePriceCalldata(
                    { chainlinkCalcAddress, oracleAddress1, oracleAddress2, decimalsScale, spread: takingSpread.toString() },
                ),
            },
        );
        const signature = await signOrder(order, chainId, swap.address, addr1);

        const { r, _vs: vs } = ethers.utils.splitSignature(signature);
        // taking threshold = 1 eth + 1% + eps
        const takerTraits = buildTakerTraits({
            makingAmount: true,
            extension: order.extension,
            minReturn: takingAmount.toBigInt() * takingSpread / 1000000000n + ether('0.01').toBigInt(),
        });
        const fillTx = swap.fillOrderArgs(order, r, vs, makingAmount, takerTraits.traits, takerTraits.args);
        const realTakingAmount = makingAmount.toBigInt() * // <-- makingAmount * spread / 1e9 * inchPrice / daiPrice
            takingSpread / 1000000000n *
            BigInt((await inchOracle.latestRoundData())[1]) / BigInt((await daiOracle.latestRoundData())[1]);
        await expect(fillTx).to.changeTokenBalances(dai, [addr, addr1], [-realTakingAmount, realTakingAmount]);
        await expect(fillTx).to.changeTokenBalances(inch, [addr, addr1], [makingAmount, makingAmount.mul(-1)]);
    });

    it('dai -> 1inch chainlink+eps order (check makingAmountData)', async function () {
        const { dai, inch, swap, chainId, chainlink, daiOracle, inchOracle } = await loadFixture(deployContractsAndInit);

        const chainlinkCalcAddress = chainlink.address;
        const oracleAddress1 = inchOracle.address;
        const oracleAddress2 = daiOracle.address;
        const makingAmount = ether('100').toBigInt();
        const takingAmount = ether('632').toBigInt();
        const decimalsScale = 0n;
        const makingSpread = 990000000n; // maker offset is 0.99
        const order = buildOrder(
            {
                makerAsset: inch.address,
                takerAsset: dai.address,
                makingAmount,
                takingAmount,
                maker: addr1.address,
            },
            {
                makingAmountData: buildDoublePriceCalldata(
                    { chainlinkCalcAddress, oracleAddress1: oracleAddress2, oracleAddress2: oracleAddress1, decimalsScale, spread: makingSpread },
                ),
                takingAmountData: buildDoublePriceCalldata(
                    { chainlinkCalcAddress, oracleAddress1, oracleAddress2, decimalsScale, spread: 1010000000n }, // taker offset is 1.01
                ),
            },
        );
        const signature = await signOrder(order, chainId, swap.address, addr1);

        const { r, _vs: vs } = ethers.utils.splitSignature(signature);
        // taking threshold = 1 eth + 1% + eps
        const takerTraits = buildTakerTraits({
            extension: order.extension,
            minReturn: makingAmount * makingSpread / 1000000000n + ether('0.01').toBigInt(),
        });
        const fillTx = swap.fillOrderArgs(order, r, vs, takingAmount, takerTraits.traits, takerTraits.args);
        const realMakingAmount = takingAmount * // <-- takingAmount * spread / 1e9 * daiPrice / inchPrice
            makingSpread / 1000000000n *
            BigInt((await daiOracle.latestRoundData())[1]) / BigInt((await inchOracle.latestRoundData())[1]);
        await expect(fillTx).to.changeTokenBalances(dai, [addr, addr1], [-takingAmount, takingAmount]);
        await expect(fillTx).to.changeTokenBalances(inch, [addr, addr1], [realMakingAmount, -realMakingAmount]);
    });

    it('dai -> 1inch stop loss order', async function () {
        const { dai, inch, swap, chainId, chainlink, daiOracle, inchOracle } = await loadFixture(deployContractsAndInit);

        const makingAmount = ether('100');
        const takingAmount = ether('631');
        const priceCall = swap.interface.encodeFunctionData('arbitraryStaticCall', [
            chainlink.address,
            chainlink.interface.encodeFunctionData('doublePrice', [inchOracle.address, daiOracle.address, '0', ether('1')]),
        ]);

        const order = buildOrder(
            {
                makerAsset: inch.address,
                takerAsset: dai.address,
                makingAmount,
                takingAmount,
                maker: addr1.address,
            }, {
                predicate: swap.interface.encodeFunctionData('lt', [ether('6.32'), priceCall]),
            },
        );
        const signature = await signOrder(order, chainId, swap.address, addr1);

        const { r, _vs: vs } = ethers.utils.splitSignature(signature);
        // taking threshold = exact taker amount + eps
        const takerTraits = buildTakerTraits({
            makingAmount: true,
            extension: order.extension,
            minReturn: takingAmount.add(ether('0.01')),
        });
        const fillTx = swap.fillOrderArgs(order, r, vs, makingAmount, takerTraits.traits, takerTraits.args);
        await expect(fillTx).to.changeTokenBalances(dai, [addr, addr1], [takingAmount.mul(-1), takingAmount]);
        await expect(fillTx).to.changeTokenBalances(inch, [addr, addr1], [makingAmount, makingAmount.mul(-1)]);
    });

    it('dai -> 1inch stop loss order predicate is invalid', async function () {
        const { dai, inch, swap, chainId, chainlink, daiOracle, inchOracle } = await loadFixture(deployContractsAndInit);

        const makingAmount = ether('100');
        const takingAmount = ether('631');
        const priceCall = chainlink.interface.encodeFunctionData('doublePrice', [inchOracle.address, daiOracle.address, '0', ether('1')]);

        const order = buildOrder(
            {
                makerAsset: inch.address,
                takerAsset: dai.address,
                makingAmount,
                takingAmount,
                maker: addr1.address,
            },
            {
                predicate: swap.interface.encodeFunctionData('lt', [ether('6.31'), priceCall]),
            },
        );
        const signature = await signOrder(order, chainId, swap.address, addr1);

        const { r, _vs: vs } = ethers.utils.splitSignature(signature);
        const takerTraits = buildTakerTraits({
            makingAmount: true,
            extension: order.extension,
            minReturn: takingAmount.add(ether('0.01')),
        });
        await expect(
            swap.fillOrderArgs(order, r, vs, makingAmount, takerTraits.traits, takerTraits.args), // taking threshold = exact taker amount + eps
        ).to.be.revertedWithCustomError(swap, 'PredicateIsNotTrue');
    });

    it('eth -> dai stop loss order', async function () {
        const { dai, weth, swap, chainId, daiOracle } = await loadFixture(deployContractsAndInit);

        const makingAmount = ether('1');
        const takingAmount = ether('4000');
        const latestAnswerCall = swap.interface.encodeFunctionData('arbitraryStaticCall', [
            daiOracle.address,
            daiOracle.interface.encodeFunctionData('latestAnswer'),
        ]);

        const order = buildOrder(
            {
                makerAsset: weth.address,
                takerAsset: dai.address,
                makingAmount,
                takingAmount,
                maker: addr1.address,
            },
            {
                predicate: swap.interface.encodeFunctionData('lt', [ether('0.0002501'), latestAnswerCall]),
            },
        );
        const signature = await signOrder(order, chainId, swap.address, addr1);

        const { r, _vs: vs } = ethers.utils.splitSignature(signature);
        const takerTraits = buildTakerTraits({
            makingAmount: true,
            extension: order.extension,
            minReturn: takingAmount,
        });
        const fillTx = swap.fillOrderArgs(order, r, vs, makingAmount, takerTraits.traits, takerTraits.args);
        await expect(fillTx).to.changeTokenBalances(dai, [addr, addr1], [takingAmount.mul(-1), takingAmount]);
        await expect(fillTx).to.changeTokenBalances(weth, [addr, addr1], [makingAmount, makingAmount.mul(-1)]);
    });
});
