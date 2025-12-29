export interface Account {
  id: string;
  name: string;
  fields?: Record<string, any>;
}

export interface VariableConfig {
  id: string;
  name: string;
  data_source: string;
  account_field_name?: string;
  role?: string;
  is_attacker_field?: boolean;
  account_scope_mode?: 'all' | 'only_selected' | 'exclude_selected';
  account_scope_ids?: string[];
}

export interface VariableValidationResult {
  name: string;
  field_key: string;
  role: 'attacker' | 'victim' | 'neutral';
  pool_total: number;
  present: number;
  missing: number;
  coverage_rate: number;
  severity: 'ok' | 'warn' | 'fatal';
  message?: string;
}

export interface ValidationReport {
  strategy: string;
  attacker_account_id?: string;
  variables: VariableValidationResult[];
  fatal_errors: string[];
  warnings: string[];
}

export interface PreparedAccountPools {
  valid: boolean;
  report: ValidationReport;
  variablePools: Map<string, Account[]>;
  filteredAccounts: Account[];
}

export function resolveAccountPool(
  accounts: Account[],
  scopeMode: 'all' | 'only_selected' | 'exclude_selected' | undefined,
  scopeIds: string[] | undefined
): Account[] {
  if (!scopeMode || scopeMode === 'all' || !scopeIds || scopeIds.length === 0) {
    return accounts;
  }

  const scopeIdSet = new Set(scopeIds);

  if (scopeMode === 'only_selected') {
    return accounts.filter(a => scopeIdSet.has(a.id));
  }

  if (scopeMode === 'exclude_selected') {
    return accounts.filter(a => !scopeIdSet.has(a.id));
  }

  return accounts;
}

function analyzeVariableCoverage(
  variable: VariableConfig,
  pool: Account[]
): { present: number; missing: number; presentAccounts: Account[] } {
  const fieldKey = variable.account_field_name;
  if (!fieldKey) {
    return { present: 0, missing: pool.length, presentAccounts: [] };
  }

  const presentAccounts: Account[] = [];
  let missing = 0;

  for (const account of pool) {
    const value = account.fields?.[fieldKey];
    if (value !== undefined && value !== null && value !== '') {
      presentAccounts.push(account);
    } else {
      missing++;
    }
  }

  return { present: presentAccounts.length, missing, presentAccounts };
}

function determineVariableRole(variable: VariableConfig): 'attacker' | 'victim' | 'neutral' {
  if (variable.is_attacker_field || variable.role === 'attacker') {
    return 'attacker';
  }
  if (variable.role === 'victim') {
    return 'victim';
  }
  return 'neutral';
}

export function validateAndPrepareAccountPoolsForWorkflowRun(
  accounts: Account[],
  variableConfigs: VariableConfig[],
  strategy: string,
  attackerAccountId?: string
): PreparedAccountPools {
  const accountFieldVars = variableConfigs.filter(v => v.data_source === 'account_field' && v.account_field_name);

  const report: ValidationReport = {
    strategy,
    attacker_account_id: attackerAccountId,
    variables: [],
    fatal_errors: [],
    warnings: [],
  };

  const variablePools = new Map<string, Account[]>();

  if (accountFieldVars.length === 0) {
    return { valid: true, report, variablePools, filteredAccounts: accounts };
  }

  for (const variable of accountFieldVars) {
    const basePool = resolveAccountPool(
      accounts,
      variable.account_scope_mode,
      variable.account_scope_ids
    );
    variablePools.set(variable.name, basePool);
  }

  switch (strategy) {
    case 'per_account':
      return validatePerAccountStrategy(accounts, accountFieldVars, variablePools, report);

    case 'anchor_attacker':
      return validateAnchorAttackerStrategy(accounts, accountFieldVars, variablePools, report, attackerAccountId);

    case 'independent':
    default:
      return validateIndependentStrategy(accounts, accountFieldVars, variablePools, report);
  }
}

function validatePerAccountStrategy(
  accounts: Account[],
  variables: VariableConfig[],
  variablePools: Map<string, Account[]>,
  report: ValidationReport
): PreparedAccountPools {
  const requiredKeys = variables.map(v => v.account_field_name!);

  let candidateAccounts: Account[] | null = null;

  for (const variable of variables) {
    const pool = variablePools.get(variable.name) || [];
    if (candidateAccounts === null) {
      candidateAccounts = [...pool];
    } else {
      const poolIds = new Set(pool.map(a => a.id));
      candidateAccounts = candidateAccounts.filter(a => poolIds.has(a.id));
    }
  }

  candidateAccounts = candidateAccounts || [];

  const qualifiedAccounts = candidateAccounts.filter(account => {
    for (const key of requiredKeys) {
      const value = account.fields?.[key];
      if (value === undefined || value === null || value === '') {
        return false;
      }
    }
    return true;
  });

  for (const variable of variables) {
    const pool = variablePools.get(variable.name) || [];
    const coverage = analyzeVariableCoverage(variable, pool);
    const coverageRate = pool.length > 0 ? coverage.present / pool.length : 0;

    const result: VariableValidationResult = {
      name: variable.name,
      field_key: variable.account_field_name!,
      role: determineVariableRole(variable),
      pool_total: pool.length,
      present: coverage.present,
      missing: coverage.missing,
      coverage_rate: coverageRate,
      severity: 'ok',
    };

    if (coverage.present === 0) {
      result.severity = 'fatal';
      result.message = `No accounts have field "${variable.account_field_name}"`;
      report.fatal_errors.push(`Variable "${variable.name}": no accounts have field "${variable.account_field_name}"`);
    } else if (coverageRate < 0.3) {
      result.severity = 'warn';
      result.message = `Low coverage: ${Math.round(coverageRate * 100)}%`;
      report.warnings.push(`Variable "${variable.name}" coverage low: ${Math.round(coverageRate * 100)}%`);
    }

    report.variables.push(result);
  }

  if (qualifiedAccounts.length === 0) {
    report.fatal_errors.push(`per_account: no accounts have all required fields [${requiredKeys.join(', ')}]`);
  }

  const allPoolsUpdated = new Map<string, Account[]>();
  for (const variable of variables) {
    allPoolsUpdated.set(variable.name, qualifiedAccounts);
  }

  return {
    valid: report.fatal_errors.length === 0,
    report,
    variablePools: allPoolsUpdated,
    filteredAccounts: qualifiedAccounts,
  };
}

function validateAnchorAttackerStrategy(
  accounts: Account[],
  variables: VariableConfig[],
  variablePools: Map<string, Account[]>,
  report: ValidationReport,
  attackerAccountId?: string
): PreparedAccountPools {
  if (!attackerAccountId) {
    report.fatal_errors.push('anchor_attacker strategy requires attacker_account_id');
    return { valid: false, report, variablePools, filteredAccounts: [] };
  }

  const attacker = accounts.find(a => a.id === attackerAccountId);
  if (!attacker) {
    report.fatal_errors.push(`Attacker account "${attackerAccountId}" not found`);
    return { valid: false, report, variablePools, filteredAccounts: [] };
  }

  const attackerVars = variables.filter(v => v.is_attacker_field || v.role === 'attacker');
  const victimVars = variables.filter(v => !v.is_attacker_field && v.role !== 'attacker');

  for (const variable of attackerVars) {
    const value = attacker.fields?.[variable.account_field_name!];
    const hasValue = value !== undefined && value !== null && value !== '';

    const result: VariableValidationResult = {
      name: variable.name,
      field_key: variable.account_field_name!,
      role: 'attacker',
      pool_total: 1,
      present: hasValue ? 1 : 0,
      missing: hasValue ? 0 : 1,
      coverage_rate: hasValue ? 1 : 0,
      severity: hasValue ? 'ok' : 'fatal',
    };

    if (!hasValue) {
      result.message = `Attacker account missing field "${variable.account_field_name}"`;
      report.fatal_errors.push(`Attacker account missing required field: ${variable.account_field_name}`);
    }

    report.variables.push(result);
    variablePools.set(variable.name, hasValue ? [attacker] : []);
  }

  const nonAttackerAccounts = accounts.filter(a => a.id !== attackerAccountId);

  for (const variable of victimVars) {
    let victimPool = resolveAccountPool(
      nonAttackerAccounts,
      variable.account_scope_mode,
      variable.account_scope_ids
    );

    const coverage = analyzeVariableCoverage(variable, victimPool);
    const coverageRate = victimPool.length > 0 ? coverage.present / victimPool.length : 0;

    const result: VariableValidationResult = {
      name: variable.name,
      field_key: variable.account_field_name!,
      role: 'victim',
      pool_total: victimPool.length,
      present: coverage.present,
      missing: coverage.missing,
      coverage_rate: coverageRate,
      severity: 'ok',
    };

    if (coverage.present === 0) {
      result.severity = 'fatal';
      result.message = `No victim accounts have field "${variable.account_field_name}"`;
      report.fatal_errors.push(`No victim accounts have field "${variable.account_field_name}" for variable "${variable.name}"`);
    } else if (coverageRate < 0.3) {
      result.severity = 'warn';
      result.message = `Low victim coverage: ${Math.round(coverageRate * 100)}%`;
      report.warnings.push(`Victim pool coverage low for "${variable.name}": ${Math.round(coverageRate * 100)}%`);
    }

    report.variables.push(result);
    variablePools.set(variable.name, coverage.presentAccounts);
  }

  const validVictims = victimVars.length > 0
    ? victimVars.reduce<Account[] | null>((acc, v) => {
        const pool = variablePools.get(v.name) || [];
        if (acc === null) return [...pool];
        const poolIds = new Set(pool.map(a => a.id));
        return acc.filter(a => poolIds.has(a.id));
      }, null) || []
    : nonAttackerAccounts;

  return {
    valid: report.fatal_errors.length === 0,
    report,
    variablePools,
    filteredAccounts: [attacker, ...validVictims],
  };
}

function validateIndependentStrategy(
  accounts: Account[],
  variables: VariableConfig[],
  variablePools: Map<string, Account[]>,
  report: ValidationReport
): PreparedAccountPools {
  for (const variable of variables) {
    const pool = variablePools.get(variable.name) || [];
    const coverage = analyzeVariableCoverage(variable, pool);
    const coverageRate = pool.length > 0 ? coverage.present / pool.length : 0;

    const result: VariableValidationResult = {
      name: variable.name,
      field_key: variable.account_field_name!,
      role: determineVariableRole(variable),
      pool_total: pool.length,
      present: coverage.present,
      missing: coverage.missing,
      coverage_rate: coverageRate,
      severity: 'ok',
    };

    if (coverage.present === 0) {
      result.severity = 'fatal';
      result.message = `No accounts have field "${variable.account_field_name}"`;
      report.fatal_errors.push(`Variable "${variable.name}": no accounts in pool have field "${variable.account_field_name}"`);
    } else if (coverageRate < 0.3) {
      result.severity = 'warn';
      result.message = `Low coverage: ${Math.round(coverageRate * 100)}%`;
      report.warnings.push(`Variable "${variable.name}" coverage low: ${Math.round(coverageRate * 100)}%`);
    }

    report.variables.push(result);
    variablePools.set(variable.name, coverage.presentAccounts);
  }

  return {
    valid: report.fatal_errors.length === 0,
    report,
    variablePools,
    filteredAccounts: accounts,
  };
}

export interface TemplateVariable {
  name: string;
  json_path: string;
  data_source?: string;
  account_field_name?: string;
  account_scope_mode?: 'all' | 'only_selected' | 'exclude_selected';
  account_scope_ids?: string[];
  role?: string;
  is_attacker_field?: boolean;
}

export function validateAndPrepareAccountPoolsForTemplateRun(
  accounts: Account[],
  templateVariables: TemplateVariable[],
  strategy: string,
  attackerAccountId?: string
): PreparedAccountPools {
  const variableConfigs: VariableConfig[] = templateVariables
    .filter(v => v.data_source === 'account_field' && v.account_field_name)
    .map(v => ({
      id: v.name,
      name: v.name,
      data_source: v.data_source || 'account_field',
      account_field_name: v.account_field_name,
      role: v.role,
      is_attacker_field: v.is_attacker_field,
      account_scope_mode: v.account_scope_mode,
      account_scope_ids: v.account_scope_ids,
    }));

  return validateAndPrepareAccountPoolsForWorkflowRun(
    accounts,
    variableConfigs,
    strategy,
    attackerAccountId
  );
}

export function getAccountsWithAllRequiredFields(
  accounts: Account[],
  requiredFieldKeys: string[]
): Account[] {
  if (requiredFieldKeys.length === 0) return accounts;

  return accounts.filter(account => {
    for (const key of requiredFieldKeys) {
      const value = account.fields?.[key];
      if (value === undefined || value === null || value === '') {
        return false;
      }
    }
    return true;
  });
}
