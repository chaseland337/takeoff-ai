import { handleInvites } from '../../worker/companyInvites';
import type { CompanyEnv } from '../../worker/companyAuth';

export const onRequest = (context: { request: Request; env: CompanyEnv }) => handleInvites(context.request, context.env);
