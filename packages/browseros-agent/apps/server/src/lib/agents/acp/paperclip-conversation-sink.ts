import type { UIMessage } from 'ai'
import {
  type ConversationStore,
  DbConversationStore,
} from '../../conversations/conversation-store'
import type { ConversationSink } from './paperclip-conversation'

/** All UI SDK / conversation database adaptation is contained here. */
export class DbConversationSink implements ConversationSink {
  constructor(
    private readonly store: Pick<
      ConversationStore,
      'save'
    > = new DbConversationStore(),
  ) {}

  async replace(input: Parameters<ConversationSink['replace']>[0]) {
    const messages: UIMessage[] = input.messages
    await this.store.save({
      id: input.conversationId,
      agentId: input.agentId,
      targetType: 'paperclip',
      messages,
    })
  }
}
