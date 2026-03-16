import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface SearchRequest {
  search_type: 'jsonpath' | 'keyword' | 'header_key' | 'query_param';
  pattern: string;
  scopes: ('body' | 'header' | 'query' | 'path')[];
  match_mode: 'exact' | 'contains';
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

interface SearchMatch {
  template_id: string;
  template_name: string;
  group_name?: string;
  variable_type: 'body' | 'header' | 'query' | 'path';
  variable_name: string;
  json_path: string;
  current_config: {
    operation_type?: 'replace' | 'append';
    data_source?: 'checklist' | 'account_field' | 'security_rule' | 'original';
    checklist_id?: string;
    account_field_name?: string;
    security_rule_id?: string;
  };
  raw_snippet?: string;
}

function getVariableType(jsonPath: string): 'body' | 'header' | 'query' | 'path' {
  if (jsonPath.startsWith('body.')) return 'body';
  if (jsonPath.startsWith('headers.')) return 'header';
  if (jsonPath.startsWith('query.')) return 'query';
  if (jsonPath.startsWith('path.')) return 'path';
  return 'body';
}

function extractFieldName(jsonPath: string): string {
  const parts = jsonPath.split('.');
  return parts[parts.length - 1] || jsonPath;
}

function matchesPattern(value: string, pattern: string, matchMode: 'exact' | 'contains'): boolean {
  const lowerValue = value.toLowerCase();
  const lowerPattern = pattern.toLowerCase();

  if (matchMode === 'exact') {
    return lowerValue === lowerPattern;
  }
  return lowerValue.includes(lowerPattern);
}

function extractSnippet(rawRequest: string, jsonPath: string, maxLength: number = 200): string {
  if (!rawRequest) return '';

  const fieldName = extractFieldName(jsonPath);
  const index = rawRequest.toLowerCase().indexOf(fieldName.toLowerCase());

  if (index === -1) return '';

  const start = Math.max(0, index - 30);
  const end = Math.min(rawRequest.length, index + fieldName.length + 50);

  let snippet = rawRequest.substring(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < rawRequest.length) snippet = snippet + '...';

  return snippet.substring(0, maxLength);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: SearchRequest = await req.json();
    const { search_type, pattern, scopes, match_mode } = body;

    if (!pattern || pattern.trim() === '') {
      return new Response(JSON.stringify({ error: 'Pattern is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { data: templates, error } = await supabase
      .from('api_templates')
      .select('id, name, group_name, variables, raw_request')
      .eq('is_active', true);

    if (error) {
      throw new Error(`Failed to fetch templates: ${error.message}`);
    }

    const matches: SearchMatch[] = [];
    const searchPattern = pattern.trim();
    const activeScopes = scopes || ['body', 'header', 'query', 'path'];

    for (const template of templates || []) {
      const variables: VariableConfig[] = template.variables || [];

      for (const variable of variables) {
        const varType = getVariableType(variable.json_path);

        if (!activeScopes.includes(varType)) continue;

        let shouldMatch = false;
        const fieldName = extractFieldName(variable.json_path);

        switch (search_type) {
          case 'jsonpath':
            shouldMatch = matchesPattern(variable.json_path, searchPattern, match_mode);
            break;
          case 'keyword':
            shouldMatch = matchesPattern(fieldName, searchPattern, match_mode) ||
                         matchesPattern(variable.name, searchPattern, match_mode) ||
                         matchesPattern(variable.json_path, searchPattern, match_mode);
            break;
          case 'header_key':
            if (varType === 'header') {
              const headerKey = variable.json_path.replace('headers.', '');
              shouldMatch = matchesPattern(headerKey, searchPattern, match_mode);
            }
            break;
          case 'query_param':
            if (varType === 'query') {
              const queryParam = variable.json_path.replace('query.', '');
              shouldMatch = matchesPattern(queryParam, searchPattern, match_mode);
            }
            break;
        }

        if (shouldMatch) {
          matches.push({
            template_id: template.id,
            template_name: template.name,
            group_name: template.group_name,
            variable_type: varType,
            variable_name: variable.name,
            json_path: variable.json_path,
            current_config: {
              operation_type: variable.operation_type,
              data_source: variable.data_source || 'original',
              checklist_id: variable.checklist_id,
              account_field_name: variable.account_field_name,
              security_rule_id: variable.security_rule_id,
            },
            raw_snippet: extractSnippet(template.raw_request, variable.json_path),
          });
        }
      }
    }

    matches.sort((a, b) => {
      if (a.template_name !== b.template_name) {
        return a.template_name.localeCompare(b.template_name);
      }
      return a.variable_name.localeCompare(b.variable_name);
    });

    return new Response(JSON.stringify({
      success: true,
      matches,
      total_count: matches.length,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Search error:', error);
    return new Response(JSON.stringify({ error: error.message || 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});