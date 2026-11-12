/** Downloads and decodes an image off-screen so it can appear without a flash. */
export function preloadImage(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  if (typeof image.decode === 'function') return image.decode();
  return new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Image failed to load.'));
  });
}
