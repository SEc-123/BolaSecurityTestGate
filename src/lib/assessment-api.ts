import { apiRequest, API_BASE_URL } from './api-client';
import type { AssessmentRun, ProductAssessmentState } from '../types/assessment';
export interface BusinessScenario { id: string; business_name: string; test_name: string; app_package: string; description: string; depends_on: string[] }
export interface BusinessProfile { id: string; name: string; enabled: boolean; simulated: boolean; device_label: string; scenarios: BusinessScenario[] }
export interface BusinessApp { id: string; name: string; package_name?: string; ready: boolean }
export const assessmentApi = {
  list: () => apiRequest<AssessmentRun[]>('/api/ai-scans/product-runs'),
  read: (id: string, signal?: AbortSignal) => apiRequest<ProductAssessmentState>(`/api/ai-scans/${encodeURIComponent(id)}/product-state`, { signal }),
  events: (id: string) => `${API_BASE_URL}/api/ai-scans/${encodeURIComponent(id)}/product-events`,
  image: (url: string) => /^\/api\/ai-scans\/[^/]+\/frames\//.test(url) ? `${API_BASE_URL}${url}` : '',
  create: (body: Record<string, unknown>) => apiRequest<ProductAssessmentState>('/api/ai-scans?view=product', {method:'POST', body:JSON.stringify(body)}),
  run: (id: string) => apiRequest<{scan_run_id: string; running: boolean; snapshot: ProductAssessmentState}>(`/api/ai-scans/${encodeURIComponent(id)}/run-async?view=product`, {method:'POST',body:'{}'}),
  select: (id: string, types: string[]) => apiRequest<ProductAssessmentState>(`/api/ai-scans/${encodeURIComponent(id)}/select-vulns?view=product`, {method:'POST',body:JSON.stringify({selected_vuln_types:types})}),
  profiles: () => apiRequest<BusinessProfile[]>('/api/mobile/business-profiles'),
  importApp: (profileId: string, filename: string, base64: string) => apiRequest<BusinessApp>('/api/mobile/apps/import?view=product', {method:'POST',body:JSON.stringify({profile_id:profileId,filename,base64,apk_source:'operator_authorized_browser_upload'})}),
};
