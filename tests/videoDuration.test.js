jest.mock('get-video-duration', () => ({ getVideoDurationInSeconds: jest.fn() }));
const { getVideoDurationInSeconds } = require('get-video-duration');
const { getVideoDuration } = require('../src/utils/helpers');

test('uses the supported named video duration export and converts seconds to milliseconds', async () => {
  getVideoDurationInSeconds.mockResolvedValue(2.5);
  expect(await getVideoDuration('test.mp4')).toBe(2500);
});
test('keeps the fallback when media metadata cannot be read', async () => {
  getVideoDurationInSeconds.mockRejectedValue(new Error('invalid media'));
  expect(await getVideoDuration('bad.mp4')).toBe(14000);
});
