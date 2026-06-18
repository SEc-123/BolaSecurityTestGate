export interface BaselineConfig {
  comparison_mode?: 'status_and_body' | 'status_only' | 'body_only' | 'custom';
  rules?: {
    compare_status?: boolean;
    compare_body_structure?: boolean;
    compare_business_code?: boolean;
    business_code_path?: string;
    ignore_fields?: string[];
    critical_fields?: string[];
  };
}

export function normalizeTemplateBaselineConfig(data: any): any {
  const bindingStrategy = data.account_binding_strategy;
  const enableBaseline = data.enable_baseline;

  if (bindingStrategy === 'anchor_attacker' && enableBaseline) {
    if (!data.baseline_config || typeof data.baseline_config !== 'object') {
      data.baseline_config = {
        comparison_mode: 'status_and_body',
        rules: {
          compare_status: true,
          compare_body_structure: true,
          compare_business_code: false,
          ignore_fields: [],
          critical_fields: [],
        },
      };
    } else {
      if (!data.baseline_config.rules) {
        data.baseline_config.rules = {};
      }

      if (data.baseline_config.rules.ignore_fields && !Array.isArray(data.baseline_config.rules.ignore_fields)) {
        data.baseline_config.rules.ignore_fields = [];
      }

      if (data.baseline_config.rules.critical_fields && !Array.isArray(data.baseline_config.rules.critical_fields)) {
        data.baseline_config.rules.critical_fields = [];
      }

      if (data.baseline_config.rules.compare_business_code && !data.baseline_config.rules.business_code_path?.trim()) {
        data.baseline_config.rules.compare_business_code = false;
      }

      if (data.baseline_config.rules.compare_status === undefined) {
        data.baseline_config.rules.compare_status = true;
      }

      if (data.baseline_config.rules.compare_body_structure === undefined) {
        data.baseline_config.rules.compare_body_structure = true;
      }
    }
  } else {
    // Keep existing config but don't use it (preserve user's work)
    // Only initialize to empty if baseline_config doesn't exist
    if (!data.baseline_config) {
      data.baseline_config = {};
    }
  }

  return data;
}
