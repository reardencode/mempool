import config from '../../config';
import feeApi from '../../api/fee-api';
import bitcoinApi from '../../api/bitcoin/bitcoin-api-factory';
import { IBitcoinApi } from '../../api/bitcoin/bitcoin-api.interface';

jest.mock('../../api/bitcoin/bitcoin-api-factory', () => ({
  __esModule: true,
  default: { $getFeeEstimates: jest.fn() },
}));

let mempoolInfo: Partial<IBitcoinApi.MempoolInfo>;
jest.mock('../../api/mempool', () => ({
  __esModule: true,
  default: { getMempoolInfo: () => mempoolInfo },
}));

// No projected blocks: mempool's own estimator answers minimumFee at every priority.
jest.mock('../../api/mempool-blocks', () => ({
  __esModule: true,
  default: { getMempoolBlocks: () => [] },
}));

const getFeeEstimates = (bitcoinApi as unknown as { $getFeeEstimates: jest.Mock }).$getFeeEstimates;

// Esplora /fee-estimates is confirm-target → sat/vB. Missing targets are absent.
function esploraAnswers(byTarget: Record<string, number>): void {
  getFeeEstimates.mockResolvedValue(byTarget);
}

describe('Fee API with FEE_ESTIMATES = node', () => {
  beforeEach(() => {
    config.MEMPOOL.FEE_ESTIMATES = 'node';
    config.MEMPOOL.BACKEND = 'esplora';
    mempoolInfo = { mempoolminfee: 0.000011 }; // 1.1 sat/vB
    getFeeEstimates.mockReset();
  });

  test('serves Esplora fee-estimates for targets 1, 2, 3 and 144 blocks', async () => {
    esploraAnswers({ '1': 12.345, '2': 8, '3': 3, '144': 1.5, '6': 2.5, '1008': 0.2 });
    await feeApi.$updateNodeEstimates();

    expect(getFeeEstimates).toHaveBeenCalledTimes(1);
    expect(feeApi.getPreciseRecommendedFee()).toEqual({
      fastestFee: 12.345, halfHourFee: 8, hourFee: 3, economyFee: 1.5, minimumFee: 1.1,
    });
    expect(feeApi.getRecommendedFee()).toEqual({
      fastestFee: 13, halfHourFee: 8, hourFee: 3, economyFee: 2, minimumFee: 2,
    });
  });

  test('floors estimates at mempoolminfee and keeps priorities ordered', async () => {
    esploraAnswers({ '1': 2, '2': 4, '3': 1, '144': 0.5 });
    await feeApi.$updateNodeEstimates();

    expect(feeApi.getPreciseRecommendedFee()).toEqual({
      fastestFee: 4, halfHourFee: 4, hourFee: 1.1, economyFee: 1.1, minimumFee: 1.1,
    });
  });

  test('falls back to the mempool estimator when a homescreen target is missing', async () => {
    esploraAnswers({ '1': 12.345, '2': 8, '3': 3, '144': 1.5 });
    await feeApi.$updateNodeEstimates();
    esploraAnswers({ '1': 12.345, '6': 3 }); // curve without the 2-block rate
    await feeApi.$updateNodeEstimates();

    expect(feeApi.getRecommendedFee()).toEqual({
      fastestFee: 2, halfHourFee: 2, hourFee: 2, economyFee: 2, minimumFee: 2,
    });
  });

  test('falls back to the mempool estimator when the Esplora request fails', async () => {
    esploraAnswers({ '1': 12.345, '2': 8, '3': 3, '144': 1.5 });
    await feeApi.$updateNodeEstimates();
    getFeeEstimates.mockRejectedValue(new Error('connect ENOENT'));
    await feeApi.$updateNodeEstimates();

    expect(feeApi.getRecommendedFee().fastestFee).toBe(2);
  });

  test('does not query Esplora in the default mempool mode', async () => {
    config.MEMPOOL.FEE_ESTIMATES = 'mempool';
    esploraAnswers({ '1': 12.345, '2': 8, '3': 3, '144': 1.5 });
    await feeApi.$updateNodeEstimates();

    expect(getFeeEstimates).not.toHaveBeenCalled();
    expect(feeApi.getRecommendedFee().fastestFee).toBe(2);
  });
});
