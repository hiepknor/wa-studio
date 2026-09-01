import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { GroupQueryDto } from '../../contracts/groups/group-query.dto';
import { GatewayRepository } from './gateway.repository';
import { SessionScopeService } from './session-scope.service';
import {
  capabilityRefreshRequestHash,
  GroupCapabilityRefreshIdempotencyConflictError,
  requireGatewayMutationKey,
} from './gateway-mutation-idempotency';

@Injectable()
export class GroupService {
  constructor(
    private readonly repository: GatewayRepository,
    private readonly sessions: SessionScopeService,
  ) {}

  async list(query: GroupQueryDto) {
    this.sessions.assertVisible(query.sessionId);
    if (query.minParticipants !== undefined && query.maxParticipants !== undefined
      && query.minParticipants > query.maxParticipants) {
      throw new BadRequestException({
        code: 'GROUP_FILTER_PARTICIPANTS_RANGE_INVALID',
        message: 'Participant count filter range is invalid.',
        fieldErrors: {
          minParticipants: ['Must be less than or equal to maxParticipants.'],
          maxParticipants: ['Must be greater than or equal to minParticipants.'],
        },
        details: {},
      });
    }
    const result = await this.repository.listGroups(query);
    return { data: result.data, meta: { total: result.total, limit: query.limit, offset: query.offset } };
  }

  async get(sessionId: string, groupId: string) {
    this.sessions.assertVisible(sessionId);
    const group = await this.repository.findGroup(sessionId, groupId, false);
    if (!group) throw new NotFoundException('Group not found');
    return group;
  }

  async members(sessionId: string, groupId: string, limit: number, offset: number, query?: string) {
    this.sessions.assertVisible(sessionId);
    if (!await this.repository.findGroup(sessionId, groupId, false)) throw new NotFoundException('Group not found');
    const result = await this.repository.listMembers(sessionId, groupId, limit, offset, query);
    return {
      data: result.data,
      meta: { total: result.total, limit, offset, datasetRevision: result.datasetRevision },
    };
  }

  async refreshCapability(
    sessionId: string,
    groupId: string,
    rawIdempotencyKey: string | undefined,
  ) {
    this.sessions.assertVisible(sessionId);
    const idempotencyKey = requireGatewayMutationKey(
      'GROUP_CAPABILITY_REFRESH',
      rawIdempotencyKey,
    );
    try {
      const result = await this.repository.requestGroupCapabilityRefreshIdempotent(
        sessionId,
        groupId,
        {
          key: idempotencyKey,
          requestHash: capabilityRefreshRequestHash(sessionId, groupId),
        },
      );
      if (!result) throw new NotFoundException('Group not found');
      return result;
    } catch (error) {
      if (error instanceof GroupCapabilityRefreshIdempotencyConflictError) {
        throw new ConflictException({
          code: 'GROUP_CAPABILITY_REFRESH_IDEMPOTENCY_CONFLICT',
          message: error.message,
          details: {},
        });
      }
      throw error;
    }
  }

  async getCapabilityRefresh(sessionId: string, groupId: string, requestRevision?: number) {
    this.sessions.assertVisible(sessionId);
    const operation = await this.repository.findGroupCapabilityRefresh(
      sessionId,
      groupId,
      requestRevision,
    );
    if (!operation) throw new NotFoundException('Capability refresh not found');
    return operation;
  }
}
