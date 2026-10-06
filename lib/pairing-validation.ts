export const ROOM_TTL = 10 * 60 * 1000;
export class ApiError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function validateSignal(value: unknown, kind: 'offer' | 'answer') {
  if (!value || typeof value !== 'object')
    throw new ApiError('Invalid connection description.');
  const v = value as { type: string; sdp: string };
  if (
    Object.keys(v).some((k) => !['type', 'sdp'].includes(k)) ||
    v.type !== kind ||
    typeof v.sdp !== 'string' ||
    v.sdp.length > 24000 ||
    !v.sdp.startsWith('v=0') ||
    !v.sdp.includes('m=application') ||
    /m=(audio|video)/.test(v.sdp)
  )
    throw new ApiError(
      'Only bounded data-channel connection descriptions are accepted.',
    );
  return JSON.stringify({ type: v.type, sdp: v.sdp });
}
export function onlyKeys(body: Record<string, unknown>, keys: string[]) {
  if (Object.keys(body).some((k) => !keys.includes(k)))
    throw new ApiError('Unexpected request field.');
}
