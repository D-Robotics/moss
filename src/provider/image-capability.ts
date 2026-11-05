/**
 * Session memory for "this endpoint does not accept image input".
 *
 * `agent.supportsImages` is a user setting, and the default is permissive
 * (most models take images), so a text-only endpoint only reveals the problem
 * when an image-bearing request comes back 400 (classified as
 * `images_not_supported`). Without this module the next `read_image` in the same
 * session repeats the same round trip and the same failure; the model sees a
 * provider error instead of the actionable "attach nothing, describe in text"
 * guidance. Recording the rejection turns every later `read_image` in this
 * process into a local, explanatory refusal — no request, no cost.
 *
 * Deliberately process-local and one-way: capability does not come back within a
 * session (switching models mid-session reuses this process), and a cold start
 * re-probes by actually trying, which is the only way to know for a
 * user-configured gateway.
 */
let rejectedImages = false;

export function noteProviderRejectsImageInput(): void {
  rejectedImages = true;
}

export function providerRejectsImageInput(): boolean {
  return rejectedImages;
}

/**
 * The rejection is a property of the endpoint, not of the process: `/model`
 * can point the next turn at a vision model in the same process, and the stale
 * flag would keep replacing images with placeholders. Model switches clear it
 * so the new endpoint is probed by actually trying, exactly like a cold start.
 */
export function resetProviderImageRejection(): void {
  rejectedImages = false;
}
