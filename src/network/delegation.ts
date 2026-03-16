import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DelegationRequest {
  requestId: string;
  networkSessionId?: string;
  projectId: string;
  fromNodeId: string;
  fromPrincipalId: string;
  toNodeId: string;
  capabilityId: string;
  input: {
    prompt?: string;
    paths?: string[];
    artifactRefs?: string[];
    metadata?: Record<string, unknown>;
  };
  createdAt: string;
}

export interface DelegationResult {
  requestId: string;
  projectId: string;
  fromNodeId: string;
  toNodeId: string;
  status: 'ok' | 'denied' | 'failed';
  summary: string;
  artifacts?: Array<{
    kind: 'text' | 'patch' | 'file-ref' | 'report';
    value: string;
  }>;
  error?: string;
  createdAt: string;
}

export class DelegationStore {
  private requests = new Map<string, DelegationRequest>();
  private results = new Map<string, DelegationResult>();
  private loaded = false;

  constructor(
    private requestsFile: string,
    private resultsFile: string,
  ) {}

  async load(): Promise<void> {
    await mkdir(dirname(this.requestsFile), { recursive: true });
    const requests = await this.readJsonFile<DelegationRequest[]>(this.requestsFile, []);
    const results = await this.readJsonFile<DelegationResult[]>(this.resultsFile, []);
    this.requests = new Map(requests.map((request) => [request.requestId, request]));
    this.results = new Map(results.map((result) => [result.requestId, result]));
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.requestsFile), { recursive: true });
    await writeFile(this.requestsFile, JSON.stringify(this.listRequests(), null, 2) + '\n', 'utf-8');
    await writeFile(this.resultsFile, JSON.stringify(this.listResults(), null, 2) + '\n', 'utf-8');
  }

  listRequests(): DelegationRequest[] {
    return Array.from(this.requests.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listResults(): DelegationResult[] {
    return Array.from(this.results.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRequest(requestId: string): DelegationRequest | null {
    return this.requests.get(requestId) ?? null;
  }

  getResult(requestId: string): DelegationResult | null {
    return this.results.get(requestId) ?? null;
  }

  async createRequest(input: Omit<DelegationRequest, 'requestId' | 'createdAt'>): Promise<DelegationRequest> {
    await this.ensureLoaded();
    const request: DelegationRequest = {
      ...input,
      requestId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.requests.set(request.requestId, request);
    await this.save();
    return request;
  }

  async saveIncomingRequest(request: DelegationRequest): Promise<DelegationRequest> {
    await this.ensureLoaded();
    this.requests.set(request.requestId, request);
    await this.save();
    return request;
  }

  async saveResult(result: DelegationResult): Promise<DelegationResult> {
    await this.ensureLoaded();
    this.results.set(result.requestId, result);
    await this.save();
    return result;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  }
}
