import { BadRequestException, ConflictException } from '@nestjs/common';

export class AutomationValidationError extends BadRequestException {}

export class AutomationTooManyStepsError extends BadRequestException {
  constructor(max: number) {
    super(`An automation cannot have more than ${max} steps.`);
  }
}

export class AutomationLoopError extends BadRequestException {
  constructor(maxDepth: number) {
    super(
      `Trigger chain exceeds the maximum allowed depth of ${maxDepth} — refusing to risk an automation loop.`,
    );
  }
}

export class AutomationRunConflictError extends ConflictException {
  constructor() {
    super(
      'This automation already has an active run (queued, running, or waiting for approval).',
    );
  }
}
