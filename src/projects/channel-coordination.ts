import type { ProjectBinding } from './types.js';

export interface ProjectRoomMember {
  userId: string;
  username?: string;
  displayName?: string;
  mention?: string;
  source: string;
}

export interface ProjectRoomInspection {
  guildId?: string;
  guildName?: string;
  channelId: string;
  channelName?: string;
  kind: 'channel' | 'thread' | 'dm';
  private: boolean;
  members: ProjectRoomMember[];
  notes: string[];
}

export interface ProjectRoomBootstrapRequest {
  agentId?: string;
  guildId: string;
  currentChannelTarget: string;
  currentThreadId?: string;
  parentChannelId?: string;
  slug: string;
  displayName: string;
  description: string;
  destination: 'channel' | 'thread' | 'here';
  ownerUserId: string;
}

export interface ProjectRoomBootstrapResult {
  channelTarget: string;
  threadId?: string;
  createdChannel?: { id: string; name: string } | null;
  createdThread?: { id: string; name: string } | null;
}

export interface ProjectChannelCoordinator {
  readonly platform: ProjectBinding['platform'];
  notifyBindings(bindings: ProjectBinding[], content: string): Promise<void>;
  inspectRoom(input: { agentId?: string; channelId: string }): Promise<ProjectRoomInspection>;
  grantRoomAccess(input: { agentId?: string; channelId: string; userId: string }): Promise<void>;
  bootstrapProjectRoom(input: ProjectRoomBootstrapRequest): Promise<ProjectRoomBootstrapResult>;
}

export class ProjectChannelCoordinatorRegistry {
  private coordinators = new Map<ProjectBinding['platform'], ProjectChannelCoordinator>();

  register(coordinator: ProjectChannelCoordinator): void {
    this.coordinators.set(coordinator.platform, coordinator);
  }

  get(platform: ProjectBinding['platform']): ProjectChannelCoordinator | undefined {
    return this.coordinators.get(platform);
  }
}
