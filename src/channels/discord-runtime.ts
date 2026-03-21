import type { DiscordChannel, ButtonHandler, InteractiveCommandHandler, ModalSubmitHandler, RoomClosedHandler, RoomParticipantHandler, SelectMenuHandler, SlashCommandHandler } from './discord.js';

interface DiscordRuntimeBaseInput {
  channel: DiscordChannel;
  nativeCommandList: Array<{ name: string; description: string }>;
  slashHandler: SlashCommandHandler;
  roomClosedHandler: RoomClosedHandler;
  roomParticipantHandler: RoomParticipantHandler;
}

interface DiscordRuntimeMainInput extends DiscordRuntimeBaseInput {
  modelHandler: InteractiveCommandHandler;
  setupHandler: InteractiveCommandHandler;
  selectMenuHandler: SelectMenuHandler;
  buttonHandler: ButtonHandler;
  modalSubmitHandler: ModalSubmitHandler;
}

export function wireMainDiscordRuntime(input: DiscordRuntimeMainInput): void {
  input.channel.setSlashCommands(input.nativeCommandList, input.slashHandler);
  input.channel.setInteractiveHandler('model', input.modelHandler);
  input.channel.setInteractiveHandler('setup', input.setupHandler);
  input.channel.onRoomClosed(input.roomClosedHandler);
  input.channel.onRoomParticipant(input.roomParticipantHandler);
  input.channel.onSelectMenu(input.selectMenuHandler);
  input.channel.onButton(input.buttonHandler);
  input.channel.onModalSubmit(input.modalSubmitHandler);
}

export function wireAgentDiscordRuntime(input: DiscordRuntimeBaseInput): void {
  input.channel.setSlashCommands(input.nativeCommandList, input.slashHandler);
  input.channel.onRoomClosed(input.roomClosedHandler);
  input.channel.onRoomParticipant(input.roomParticipantHandler);
}
