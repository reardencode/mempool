import { MempoolBlock } from '../mempool.interfaces';
import { IBitcoinApi } from './bitcoin/bitcoin-api.interface';
import config from '../config';
import mempool from './mempool';
import projectedBlocks from './mempool-blocks';
import bitcoinApi from './bitcoin/bitcoin-api-factory';
import logger from '../logger';

const isLiquid = config.MEMPOOL.NETWORK === 'liquid' || config.MEMPOOL.NETWORK === 'liquidtestnet';

// Longest first, so a shorter target is never shown below a longer one.
// Homescreen boxes: next block, 2 blocks, 3 blocks, then the 1-day economy rate.
const NODE_ESTIMATE_TARGETS = [144, 3, 2, 1];

interface RecommendedFees {
  fastestFee: number,
  halfHourFee: number,
  hourFee: number,
  economyFee: number,
  minimumFee: number,
}

class FeeApi {
  constructor() { }

  minimumIncrement = isLiquid ? 0.1 : 1;
  minFastestFee = isLiquid ? 0.1 : 1;
  minHalfHourFee = isLiquid ? 0.1 : 0.5;
  priorityFactor = isLiquid ? 0 : 0.5;

  // sat/kvB per NODE_ESTIMATE_TARGETS, null while the node has no estimate
  private nodeEstimates: number[] | null = null;

  /**
   * With FEE_ESTIMATES = 'node', refresh Esplora `/fee-estimates`.
   * That map is per confirmation target. `estimatesmartfee` is not: it is one
   * 10-minute quote, so targets 1, 2 and 3 would show the same rate.
   * On any failure recommendations fall back to the projected mempool blocks.
   * @asyncSafe
   */
  public async $updateNodeEstimates(): Promise<void> {
    if (config.MEMPOOL.FEE_ESTIMATES !== 'node') {
      this.nodeEstimates = null;
      return;
    }
    try {
      const map = await bitcoinApi.$getFeeEstimates();
      // Esplora answers sat/vB and omits a target it cannot estimate.
      const satKvb = NODE_ESTIMATE_TARGETS.map(target => {
        const satVb = map?.[String(target)];
        return typeof satVb === 'number' && Number.isFinite(satVb) && satVb > 0 ? Math.round(satVb * 1000) : Number.NaN;
      });
      this.nodeEstimates = satKvb.every(rate => rate > 0) ? satKvb : null;
    } catch (e) {
      logger.warn('Cannot fetch node fee estimates, using mempool blocks instead. Reason: ' + (e instanceof Error ? e.message : e));
      this.nodeEstimates = null;
    }
  }

  public getRecommendedFee(): RecommendedFees {
    const pBlocks = projectedBlocks.getMempoolBlocks();
    const mPool = mempool.getMempoolInfo();

    if (this.nodeEstimates) {
      return this.nodeRecommendedFee(this.nodeEstimates, mPool, this.minimumIncrement);
    }
    return this.calculateRecommendedFee(pBlocks, mPool);
  }

  public getPreciseRecommendedFee(): RecommendedFees {
    const pBlocks = projectedBlocks.getMempoolBlocks();
    const mPool = mempool.getMempoolInfo();

    if (this.nodeEstimates) {
      return this.nodeRecommendedFee(this.nodeEstimates, mPool, 0.001);
    }

    // minimum non-zero minrelaytxfee / incrementalrelayfee is 1 sat/kvB = 0.001 sat/vB
    const recommendations = this.calculateRecommendedFee(pBlocks, mPool, 0.001);
    // enforce floor & offset for highest priority recommendations while <100% hashrate accepts sub-sat fees
    recommendations.fastestFee = Math.max(recommendations.fastestFee + this.priorityFactor, this.minFastestFee);
    recommendations.halfHourFee = Math.max(recommendations.halfHourFee + (this.priorityFactor / 2), this.minHalfHourFee);
    return {
      'fastestFee': Math.round(recommendations.fastestFee * 1000) / 1000,
      'halfHourFee': Math.round(recommendations.halfHourFee * 1000) / 1000,
      'hourFee': Math.round(recommendations.hourFee * 1000) / 1000,
      'economyFee': Math.round(recommendations.economyFee * 1000) / 1000,
      'minimumFee': Math.round(recommendations.minimumFee * 1000) / 1000,
    };
  }

  public calculateRecommendedFee(pBlocks: MempoolBlock[], mPool: IBitcoinApi.MempoolInfo, minIncrement: number = this.minimumIncrement): RecommendedFees {
    const purgeRate = this.roundUpToNearest(mPool.mempoolminfee * 100000, minIncrement);
    const minimumFee = Math.max(purgeRate, minIncrement);

    if (!pBlocks.length) {
      return {
        'fastestFee': minimumFee,
        'halfHourFee': minimumFee,
        'hourFee': minimumFee,
        'economyFee': minimumFee,
        'minimumFee': minimumFee,
      };
    }

    const firstMedianFee = this.optimizeMedianFee(pBlocks[0], pBlocks[1], undefined, minimumFee, minIncrement);
    const secondMedianFee = pBlocks[1] ? this.optimizeMedianFee(pBlocks[1], pBlocks[2], firstMedianFee, minimumFee, minIncrement) : minimumFee;
    const thirdMedianFee = pBlocks[2] ? this.optimizeMedianFee(pBlocks[2], pBlocks[3], secondMedianFee, minimumFee, minIncrement) : minimumFee;

    // explicitly enforce a minimum of ceil(mempoolminfee) on all recommendations.
    // simply rounding up recommended rates is insufficient, as the purging rate
    // can exceed the median rate of projected blocks in some extreme scenarios
    // (see https://bitcoin.stackexchange.com/a/120024)
    let fastestFee = Math.max(minimumFee, firstMedianFee);
    let halfHourFee = Math.max(minimumFee, secondMedianFee);
    let hourFee = Math.max(minimumFee, thirdMedianFee);
    const economyFee = Math.max(minimumFee, Math.min(2 * minimumFee, thirdMedianFee));

    // ensure recommendations always increase w/ priority
    fastestFee = Math.max(fastestFee, halfHourFee, hourFee, economyFee);
    halfHourFee = Math.max(halfHourFee, hourFee, economyFee);
    hourFee = Math.max(hourFee, economyFee);

    return {
      'fastestFee': this.roundToNearest(fastestFee, minIncrement),
      'halfHourFee': this.roundToNearest(halfHourFee, minIncrement),
      'hourFee': this.roundToNearest(hourFee, minIncrement),
      'economyFee': this.roundToNearest(economyFee, minIncrement),
      'minimumFee': this.roundToNearest(minimumFee, minIncrement),
    };
  }

  private nodeRecommendedFee(estimates: number[], mPool: IBitcoinApi.MempoolInfo, minIncrement: number): RecommendedFees {
    const minimumFee = Math.max(this.roundUpToNearest(mPool.mempoolminfee * 100000, minIncrement), minIncrement);
    // round up in whole sat/kvB so a node estimate is never undercut
    const incrementSatKvb = Math.round(minIncrement * 1000);
    let floor = minimumFee;
    const [economyFee, hourFee, halfHourFee, fastestFee] = estimates.map(satKvb => {
      floor = Math.max(floor, Math.ceil(satKvb / incrementSatKvb) * incrementSatKvb / 1000);
      return floor;
    });
    return {
      'fastestFee': Math.round(fastestFee * 1000) / 1000,
      'halfHourFee': Math.round(halfHourFee * 1000) / 1000,
      'hourFee': Math.round(hourFee * 1000) / 1000,
      'economyFee': Math.round(economyFee * 1000) / 1000,
      'minimumFee': Math.round(minimumFee * 1000) / 1000,
    };
  }

  private optimizeMedianFee(pBlock: MempoolBlock, nextBlock: MempoolBlock | undefined, previousFee: number | undefined, minFee: number, minIncrement: number = this.minimumIncrement): number {
    const useFee = previousFee ? (pBlock.medianFee + previousFee) / 2 : pBlock.medianFee;
    if (pBlock.blockVSize <= 500000 || pBlock.medianFee < minFee) {
      return minFee;
    }
    if (pBlock.blockVSize <= 950000 && !nextBlock) {
      const multiplier = (pBlock.blockVSize - 500000) / 500000;
      return Math.max(this.roundToNearest(useFee * multiplier, minIncrement), minFee);
    }
    return Math.max(this.roundUpToNearest(useFee, minIncrement), minFee);
  }

  private roundUpToNearest(value: number, nearest: number): number {
    if (nearest !== 0) {
      return Math.ceil(value / nearest) * nearest;
    }
    return value;
  }

  private roundToNearest(value: number, nearest: number): number {
    if (nearest !== 0) {
      return Math.round(value / nearest) * nearest;
    }
    return value;
  }
}

export default new FeeApi();
