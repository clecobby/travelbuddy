import type { CameraView } from 'expo-camera';
import { ImageManipulator, SaveFormat, type ImageResult } from 'expo-image-manipulator';
import { createVideoPlayer, type VideoPlayer } from 'expo-video';

// Every camera frame we keep is shrunk to this width: small enough to upload cheaply and to send to the model.
const FRAME_WIDTH = 1024;

type ImageSource = Parameters<typeof ImageManipulator.manipulate>[0];

async function compress(source: ImageSource): Promise<ImageResult> {
  const ctx = ImageManipulator.manipulate(source);
  ctx.resize({ width: FRAME_WIDTH, height: null });
  const ref = await ctx.renderAsync();
  return ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.6, base64: true });
}

// A still from the live preview (used when the camera is on but not recording video).
export async function captureStill(camera: CameraView): Promise<ImageResult> {
  const photo = await camera.takePictureAsync({ quality: 0.7, shutterSound: false });
  return compress(photo.uri);
}

function waitUntilReady(player: VideoPlayer, timeoutMs = 4000) {
  if (player.status === 'readyToPlay') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.remove();
      reject(new Error('Video did not load in time'));
    }, timeoutMs);
    const sub = player.addListener('statusChange', ({ status }) => {
      if (status === 'readyToPlay' || status === 'error') {
        clearTimeout(timer);
        sub.remove();
        if (status === 'readyToPlay') resolve();
        else reject(new Error('Could not open video clip'));
      }
    });
  });
}

// The last frame of a just-recorded video clip, as a compressed JPEG snapshot.
export async function lastFrameOf(videoUri: string): Promise<ImageResult> {
  const player = createVideoPlayer(videoUri);
  try {
    await waitUntilReady(player);
    const at = Math.max(0, (player.duration || 1) - 0.5);
    const [thumb] = await player.generateThumbnailsAsync(at, { maxWidth: FRAME_WIDTH });
    // VideoThumbnail is a native SharedRef<'image'>; the two packages just declare that type separately.
    return await compress(thumb as unknown as ImageSource);
  } finally {
    player.release();
  }
}
