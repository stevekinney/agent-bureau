import { EXTERNAL_PROJECTION_VERSION, type ExternalExecutionProjection } from './index';

const projection: ExternalExecutionProjection = {
  version: EXTERNAL_PROJECTION_VERSION,
  audience: 'public',
  data: {},
};

void projection;
