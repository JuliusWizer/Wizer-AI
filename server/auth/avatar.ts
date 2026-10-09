const AVATAR_MAX_BYTES = 1_000_000;

export function decodeProfileImage(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("Please choose a PNG, JPG, or WebP image.");
  const [, contentType, encoded] = match;
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length > AVATAR_MAX_BYTES) throw new Error("Profile images must be 1 MB or smaller.");
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1];
  return { contentType, extension, buffer };
}
