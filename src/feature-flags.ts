import { getApiClient, GitHubApiDetails } from "./api-client";
import { CodeQL } from "./codeql";
import { Logger } from "./logging";
import { RepositoryNwo } from "./repository";
import * as util from "./util";

export interface FeatureFlags {
  getValue(flag: Feature, codeql?: CodeQL): Promise<boolean>;
}

export enum Feature {
  BypassToolcacheEnabled = "bypass_toolcache_enabled",
  MlPoweredQueriesEnabled = "ml_powered_queries_enabled",
  TrapCachingEnabled = "trap_caching_enabled",
  GolangExtractionReconciliationEnabled = "golang_extraction_reconciliation_enabled",
  CliConfigFileEnabled = "cli_config_file_enabled",
}

export const featureConfig: Record<
  Feature,
  { envVar: string; minimumVersion: string | undefined }
> = {
  [Feature.BypassToolcacheEnabled]: {
    envVar: "CODEQL_BYPASS_TOOLCACHE",
    minimumVersion: undefined,
  },
  [Feature.MlPoweredQueriesEnabled]: {
    envVar: "CODEQL_ML_POWERED_QUERIES",
    minimumVersion: "2.7.5",
  },
  [Feature.TrapCachingEnabled]: {
    envVar: "CODEQL_TRAP_CACHING",
    minimumVersion: undefined,
  },
  [Feature.GolangExtractionReconciliationEnabled]: {
    envVar: "CODEQL_GOLANG_EXTRACTION_RECONCILIATION",
    minimumVersion: undefined,
  },
  [Feature.CliConfigFileEnabled]: {
    envVar: "CODEQL_PASS_CONFIG_TO_CLI",
    minimumVersion: "2.10.1",
  },
};

/**
 * A response from the GitHub API that contains feature flag enablement information for the CodeQL
 * Action.
 *
 * It maps feature flags to whether they are enabled or not.
 */
type FeatureFlagsApiResponse = Partial<Record<Feature, boolean>>;

/**
 * Determines the enablement status of a number of features.
 * If feature enablement is not able to be determined locally, a request to the
 * github API is made to determine the enablement status.
 */
export class Features implements FeatureFlags {
  private gitHubFeatureFlags: GitHubFeatureFlags;

  constructor(
    gitHubVersion: util.GitHubVersion,
    apiDetails: GitHubApiDetails,
    repositoryNwo: RepositoryNwo,
    logger: Logger
  ) {
    this.gitHubFeatureFlags = new GitHubFeatureFlags(
      gitHubVersion,
      apiDetails,
      repositoryNwo,
      logger
    );
  }

  /**
   *
   * @param flag The feature flag to check.
   * @param codeql An optional CodeQL object. If provided, and a `minimumVersion` is specified for the
   *        feature flag, the version of the CodeQL CLI will be checked against the minimum version.
   *        If the version is less than the minimum version, the feature flag will be considered
   *        disabled. If not provided, and a `minimumVersion` is specified for the feature flag, the
   *        this function will throw.
   * @returns true if the feature flag is enabled, false otherwise.
   *
   * @throws if a `minimumVersion` is specified for the feature flag, and `codeql` is not provided.
   */
  async getValue(flag: Feature, codeql?: CodeQL): Promise<boolean> {
    if (!codeql && featureConfig[flag].minimumVersion) {
      throw new Error(
        `Internal error: A minimum version is specified for feature flag ${flag}, but no instance of CodeQL was provided.`
      );
    }

    // Bypassing the toolcache is disabled in test mode.
    if (flag === Feature.BypassToolcacheEnabled && util.isInTestMode()) {
      return false;
    }

    const envVar = (
      process.env[featureConfig[flag].envVar] || ""
    ).toLocaleLowerCase();

    // Do not use this feature if user explicitly disables it via an environment variable.
    if (envVar === "false") {
      return false;
    }

    // Never use this feature if the CLI version explicitly can't support it.
    const minimumVersion = featureConfig[flag].minimumVersion;
    if (codeql && minimumVersion) {
      if (!(await util.codeQlVersionAbove(codeql, minimumVersion))) {
        return false;
      }
    }

    // Use this feature if user explicitly enables it via an environment variable.
    if (envVar === "true") {
      return true;
    }

    // Ask the GitHub API if the feature is enabled.
    return await this.gitHubFeatureFlags.getValue(flag);
  }
}

class GitHubFeatureFlags implements FeatureFlags {
  private cachedApiResponse: FeatureFlagsApiResponse | undefined;

  constructor(
    private gitHubVersion: util.GitHubVersion,
    private apiDetails: GitHubApiDetails,
    private repositoryNwo: RepositoryNwo,
    private logger: Logger
  ) {
    /**/
  }

  async getValue(flag: Feature): Promise<boolean> {
    const response = await this.getApiResponse();
    if (response === undefined) {
      this.logger.debug(
        `No feature flags API response for ${flag}, considering it disabled.`
      );
      return false;
    }
    const flagValue = response[flag];
    if (flagValue === undefined) {
      this.logger.debug(
        `Feature flag '${flag}' undefined in API response, considering it disabled.`
      );
      return false;
    }
    return flagValue || false;
  }

  private async getApiResponse(): Promise<FeatureFlagsApiResponse> {
    const apiResponse =
      this.cachedApiResponse || (await this.loadApiResponse());
    this.cachedApiResponse = apiResponse;
    return apiResponse;
  }

  private async loadApiResponse() {
    // Do nothing when not running against github.com
    if (this.gitHubVersion.type !== util.GitHubVariant.DOTCOM) {
      this.logger.debug(
        "Not running against github.com. Disabling all feature flags."
      );
      return {};
    }
    const client = getApiClient(this.apiDetails);
    try {
      const response = await client.request(
        "GET /repos/:owner/:repo/code-scanning/codeql-action/features",
        {
          owner: this.repositoryNwo.owner,
          repo: this.repositoryNwo.repo,
        }
      );
      return response.data;
    } catch (e) {
      if (util.isHTTPError(e) && e.status === 403) {
        this.logger.warning(
          "This run of the CodeQL Action does not have permission to access Code Scanning API endpoints. " +
            "As a result, it will not be opted into any experimental features. " +
            "This could be because the Action is running on a pull request from a fork. If not, " +
            `please ensure the Action has the 'security-events: write' permission. Details: ${e}`
        );
      } else {
        // Some feature flags, such as `ml_powered_queries_enabled` affect the produced alerts.
        // Considering these feature flags disabled in the event of a transient error could
        // therefore lead to alert churn. As a result, we crash if we cannot determine the value of
        // the feature flags.
        throw new Error(
          `Encountered an error while trying to load feature flags: ${e}`
        );
      }
    }
  }
}

/**
 * Create a feature flags instance with the specified set of enabled flags.
 *
 * This should be only used within tests.
 */
export function createFeatureFlags(enabledFlags: Feature[]): FeatureFlags {
  return {
    getValue: async (flag) => {
      return enabledFlags.includes(flag);
    },
  };
}
