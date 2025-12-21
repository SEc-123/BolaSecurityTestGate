import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface SelectedMatch {
  template_id: string;
  variable_name: string;
  json_path?: string;
}

interface UpdatePatch {
  operation_type?: 'replace' | 'append';
  data_source?: 'checklist' | 'account_field' | 'security_rule';
  checklist_id?: string;
  account_field_name?: string;
  security_rule_id?: string;
}

interface BulkUpdateRequest {
  selected_matches: SelectedMatch[];
  patch: UpdatePatch;
  dry_run: boolean;
}

interface VariableConfig {
  id: string;
  name: string;
  json_path: string;
  operation_type: 'replace' | 'append';
  original_value: string;
  data_source?: 'checklist' | 'account_field' | 'security_rule';
  checklist_id?: string;
  security_rule_id?: string;
  account_field_name?: string;
}

interface UpdateResult {
  template_id: string;
  template_name: string;
  variable_name: string;
  json_path: string;
  before: Partial<VariableConfig>;
  after: Partial<VariableConfig>;
}

interface UpdateWarning {
  template_id: string;
  template_name: string;
  variable_name: string;
  reason: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: BulkUpdateRequest = await req.json();
    const { selected_matches, patch, dry_run } = body;

    if (!selected_matches || selected_matches.length === 0) {
      return new Response(JSON.stringify({ error: 'No matches selected' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!patch || Object.keys(patch).length === 0) {
      return new Response(JSON.stringify({ error: 'Patch is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const templateIds = [...new Set(selected_matches.map(m => m.template_id))];

    const { data: templates, error } = await supabase
      .from('api_templates')
      .select('id, name, variables')
      .in('id', templateIds);

    if (error) {
      throw new Error(`Failed to fetch templates: ${error.message}`);
    }

    const templateMap = new Map(templates?.map(t => [t.id, t]) || []);
    const updates: UpdateResult[] = [];
    const warnings: UpdateWarning[] = [];
    const templatesUpdates: Map<string, { name: string; variables: VariableConfig[] }> = new Map();

    for (const match of selected_matches) {
      const template = templateMap.get(match.template_id);
      if (!template) {
        warnings.push({
          template_id: match.template_id,
          template_name: 'Unknown',
          variable_name: match.variable_name,
          reason: 'Template not found',
        });
        continue;
      }

      const variables: VariableConfig[] = template.variables || [];
      const variableIndex = variables.findIndex(v =>
        v.name === match.variable_name &&
        (!match.json_path || v.json_path === match.json_path)
      );

      if (variableIndex === -1) {
        warnings.push({
          template_id: match.template_id,
          template_name: template.name,
          variable_name: match.variable_name,
          reason: 'Variable not found in template',
        });
        continue;
      }

      const variable = variables[variableIndex];
      const beforeState: Partial<VariableConfig> = {
        operation_type: variable.operation_type,
        data_source: variable.data_source,
        checklist_id: variable.checklist_id,
        account_field_name: variable.account_field_name,
        security_rule_id: variable.security_rule_id,
      };

      const updatedVariable: VariableConfig = { ...variable };

      if (patch.operation_type !== undefined) {
        updatedVariable.operation_type = patch.operation_type;
      }
      if (patch.data_source !== undefined) {
        updatedVariable.data_source = patch.data_source;
        if (patch.data_source === 'checklist') {
          updatedVariable.checklist_id = patch.checklist_id;
          updatedVariable.account_field_name = undefined;
          updatedVariable.security_rule_id = undefined;
        } else if (patch.data_source === 'account_field') {
          updatedVariable.account_field_name = patch.account_field_name;
          updatedVariable.checklist_id = undefined;
          updatedVariable.security_rule_id = undefined;
        } else if (patch.data_source === 'security_rule') {
          updatedVariable.security_rule_id = patch.security_rule_id;
          updatedVariable.checklist_id = undefined;
          updatedVariable.account_field_name = undefined;
        }
      } else {
        if (patch.checklist_id !== undefined) {
          updatedVariable.checklist_id = patch.checklist_id;
        }
        if (patch.account_field_name !== undefined) {
          updatedVariable.account_field_name = patch.account_field_name;
        }
        if (patch.security_rule_id !== undefined) {
          updatedVariable.security_rule_id = patch.security_rule_id;
        }
      }

      const afterState: Partial<VariableConfig> = {
        operation_type: updatedVariable.operation_type,
        data_source: updatedVariable.data_source,
        checklist_id: updatedVariable.checklist_id,
        account_field_name: updatedVariable.account_field_name,
        security_rule_id: updatedVariable.security_rule_id,
      };

      updates.push({
        template_id: match.template_id,
        template_name: template.name,
        variable_name: match.variable_name,
        json_path: variable.json_path,
        before: beforeState,
        after: afterState,
      });

      if (!templatesUpdates.has(match.template_id)) {
        templatesUpdates.set(match.template_id, {
          name: template.name,
          variables: [...variables],
        });
      }

      const templateUpdate = templatesUpdates.get(match.template_id)!;
      const updateIndex = templateUpdate.variables.findIndex(v =>
        v.name === match.variable_name &&
        (!match.json_path || v.json_path === match.json_path)
      );
      if (updateIndex !== -1) {
        templateUpdate.variables[updateIndex] = updatedVariable;
      }
    }

    if (!dry_run && updates.length > 0) {
      const updatePromises = Array.from(templatesUpdates.entries()).map(
        ([templateId, { variables }]) =>
          supabase
            .from('api_templates')
            .update({ variables, updated_at: new Date().toISOString() })
            .eq('id', templateId)
      );

      await Promise.all(updatePromises);
    }

    return new Response(JSON.stringify({
      success: true,
      dry_run,
      affected_count: updates.length,
      updated_templates: [...new Set(updates.map(u => u.template_id))].length,
      updates,
      warnings: warnings.length > 0 ? warnings : undefined,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Bulk update error:', error);
    return new Response(JSON.stringify({ error: error.message || 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});