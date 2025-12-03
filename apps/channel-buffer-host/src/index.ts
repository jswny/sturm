import { ChannelBuffer as SharedChannelBuffer } from "channel-buffer";
import { DurableObject } from "cloudflare:workers";

type DOEnv = Cloudflare.Env;

export class ChannelBuffer extends DurableObject {
  private readonly impl: SharedChannelBuffer;

  constructor(ctx: DurableObjectState, env: DOEnv) {
    super(ctx, env);
    this.impl = new SharedChannelBuffer(ctx, env);
  }

  fetch(request: Request): Promise<Response> | Response {
    return this.impl.fetch(request);
  }
}

export default {}
