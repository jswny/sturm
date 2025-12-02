export default {
  async queue(batch: MessageBatch<any>): Promise<void> {
    for (const message of batch.messages) {
      const body = typeof message.body === "string" ? message.body : JSON.stringify(message.body);
      try {
        const parsed = JSON.parse(body);
        console.log(JSON.stringify(parsed));
      } catch {
        console.log(body);
      }
    }
  }
};
