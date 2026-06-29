import { z } from 'zod';

const STAGE_NAMES = ['dev', 'prd'] as const;
type StageName = (typeof STAGE_NAMES)[number];

const cdkEnvSchema = z.object({
  AWS_ACCOUNT_ID: z.string().nonempty(),
});

const lambdaEnvSchema = z.object({
  GH_APP_ID: z.string().nonempty(),
  GH_APP_SECRET_PEM_KEY_NAME: z.string().nonempty(),
  GH_WEBHOOK_SECRET_KEY_NAME: z.string().nonempty(),
  CLOUDINARY_CLOUD_NAME: z.string().nonempty(),
  CLOUDINARY_API_KEY: z.string().nonempty(),
  CLOUDINARY_API_SECRET_KEY_NAME: z.string().nonempty(),
  TS_OAUTH_CLIENT_ID_KEY_NAME: z.string().nonempty(),
  TS_OAUTH_CLIENT_SECRET_KEY_NAME: z.string().nonempty(),
  TS_TAILNET_SUFFIX_KEY_NAME: z.string().nonempty(),
});

const stageName: {
  [key in StageName]: { longName: StageName; shortName: string };
} = {
  dev: {
    longName: 'dev',
    shortName: 'd',
  },
  prd: {
    longName: 'prd',
    shortName: 'p',
  },
};

interface AppParameter {
  projectName: {
    long: string;
    short: string;
  };
  github: {
    owner: string;
    repo: string;
  };
  stageName: {
    long: StageName;
    short: string;
  };
  cdkEnv: {
    account: string;
  };
  fqdn: string;
  domain: {
    api: string;
  };
  ssm: {
    oidc: {
      providerArn: string;
    };
    globalDns: {
      hostedZoneId: string;
    };
    tokyo: {
      certificateArn: string;
    };
    apiGateway: {
      apiUrl: string;
    };
    dsql: {
      clusterEndpoint: string;
      clusterArn: string;
    };
    tailscale: {
      oauthClientIdName: string;
      oauthClientSecretName: string;
      tailnetSuffixName: string;
    };
  };
  lambda: {
    blogApi: {
      githubAppId: string;
      githubAppSecretPemKeyName: string;
      githubWebhookSecretKeyName: string;
      cloudinaryCloudName: string;
      cloudinaryApiKey: string;
      cloudinaryApiSecretKeyName: string;
      tsOauthClientIdName: string;
      tsOauthClientSecretName: string;
      tsTailnetSuffixName: string;
    };
  };
}

const commonParameters = {
  projectName: {
    long: 'shuntaka',
    short: 'st',
  },
  github: {
    owner: 'shuntaka9576',
    repo: 'shuntaka-dev',
  },
};

const getCdkEnvVars = () => {
  return cdkEnvSchema.parse({
    AWS_ACCOUNT_ID: process.env.CDK_DEFAULT_ACCOUNT,
  });
};

const getLambdaEnvVars = () => {
  return lambdaEnvSchema.parse({
    GH_APP_ID: process.env.GH_APP_ID,
    GH_APP_SECRET_PEM_KEY_NAME: process.env.GH_APP_SECRET_PEM_KEY_NAME,
    GH_WEBHOOK_SECRET_KEY_NAME: process.env.GH_WEBHOOK_SECRET_KEY_NAME,
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET_KEY_NAME: process.env.CLOUDINARY_API_SECRET_KEY_NAME,
    TS_OAUTH_CLIENT_ID_KEY_NAME: process.env.TS_OAUTH_CLIENT_ID_KEY_NAME,
    TS_OAUTH_CLIENT_SECRET_KEY_NAME: process.env.TS_OAUTH_CLIENT_SECRET_KEY_NAME,
    TS_TAILNET_SUFFIX_KEY_NAME: process.env.TS_TAILNET_SUFFIX_KEY_NAME,
  });
};

const stageConfig: {
  [key in StageName]: Omit<AppParameter, 'cdkEnv' | 'ssm' | 'lambda'>;
} = {
  dev: {
    ...commonParameters,
    stageName: {
      long: stageName.dev.longName,
      short: stageName.dev.shortName,
    },
    fqdn: 'shuntaka.tech',
    domain: {
      api: 'api.shuntaka.tech',
    },
  },
  prd: {
    ...commonParameters,
    stageName: {
      long: stageName.prd.longName,
      short: stageName.prd.shortName,
    },
    fqdn: 'shuntaka.dev',
    domain: {
      api: 'api.shuntaka.dev',
    },
  },
};

// tidb-proxy stack は dev / prd 共用のため stage 非依存。SSM Parameter Store
// の path は task 文書 (docs/source/tasks/2026-06-29-blog-api-tidb-proxy.md)
// に揃えて `/tidb-proxy/...` 名前空間で扱う。
export interface ProxyParameter {
  projectName: string;
  vpc: {
    cidr: string;
  };
  ssm: {
    vpc: {
      vpcId: string;
      publicSubnetId1: string;
      privateSubnetId1: string;
    };
    proxy: {
      clusterName: string;
      ecrRepositoryUri: string;
      taskRole: string;
      taskExecRole: string;
      sgId: string;
      logGroupName: string;
      cloudMapNamespaceId: string;
      cloudMapServiceArn: string;
      serviceName: string;
    };
    tailscale: {
      // ecspresso task def の secrets[].valueFrom から runtime fetch される。
      // 値の格納 (put-parameter) は手動運用 (90 日 rotation)。
      proxyAuthKey: string;
    };
  };
}

export const getProxyConfig = (): ProxyParameter => {
  const projectName = 'tidb-proxy';
  return {
    projectName,
    vpc: {
      cidr: '10.50.0.0/16',
    },
    ssm: {
      vpc: {
        vpcId: `/${projectName}/vpc/id`,
        publicSubnetId1: `/${projectName}/vpc/public-subnet-id-1`,
        privateSubnetId1: `/${projectName}/vpc/private-subnet-id-1`,
      },
      proxy: {
        clusterName: `/${projectName}/proxy/cluster-name`,
        ecrRepositoryUri: `/${projectName}/proxy/ecr-repository-uri`,
        taskRole: `/${projectName}/proxy/task-role`,
        taskExecRole: `/${projectName}/proxy/task-exec-role`,
        sgId: `/${projectName}/proxy/sg-id`,
        logGroupName: `/${projectName}/proxy/log-group-name`,
        cloudMapNamespaceId: `/${projectName}/proxy/cloud-map-namespace-id`,
        cloudMapServiceArn: `/${projectName}/proxy/cloud-map-service-arn`,
        serviceName: `/${projectName}/proxy/service-name`,
      },
      tailscale: {
        proxyAuthKey: '/shared/shuntaka/tailscale/proxy-auth-key',
      },
    },
  };
};

export const getConfig = (stageName: string): AppParameter => {
  if (!isEnv(stageName)) {
    throw new Error(`Not found environment key: ${stageName}`);
  }

  const cdkEnvVars = getCdkEnvVars();
  const lambdaEnvVars = getLambdaEnvVars();
  const config = stageConfig[stageName];

  return {
    ...config,
    cdkEnv: {
      account: cdkEnvVars.AWS_ACCOUNT_ID,
    },
    ssm: {
      oidc: {
        providerArn: `/${config.projectName.long}/github-oidc-provider-arn`,
      },
      globalDns: {
        hostedZoneId: `/${config.stageName.long}/${config.projectName.long}/global-dns/hosted-zone-id`,
      },
      tokyo: {
        certificateArn: `/${config.stageName.long}/${config.projectName.long}/tokyo/certificate-arn`,
      },
      apiGateway: {
        apiUrl: `/${config.stageName.long}/${config.projectName.long}/api-gateway/api-url`,
      },
      dsql: {
        clusterEndpoint: `/${config.stageName.long}/${config.projectName.long}/dsql/cluster-endpoint`,
        clusterArn: `/${config.stageName.long}/${config.projectName.long}/dsql/cluster-arn`,
      },
      tailscale: {
        oauthClientIdName: `/${config.stageName.long}/${config.projectName.long}/tailscale/oauth-client-id`,
        oauthClientSecretName: `/${config.stageName.long}/${config.projectName.long}/tailscale/oauth-client-secret`,
        tailnetSuffixName: `/${config.stageName.long}/${config.projectName.long}/tailscale/tailnet-suffix`,
      },
    },
    lambda: {
      blogApi: {
        githubAppId: lambdaEnvVars.GH_APP_ID,
        githubAppSecretPemKeyName: lambdaEnvVars.GH_APP_SECRET_PEM_KEY_NAME,
        githubWebhookSecretKeyName: lambdaEnvVars.GH_WEBHOOK_SECRET_KEY_NAME,
        cloudinaryCloudName: lambdaEnvVars.CLOUDINARY_CLOUD_NAME,
        cloudinaryApiKey: lambdaEnvVars.CLOUDINARY_API_KEY,
        cloudinaryApiSecretKeyName: lambdaEnvVars.CLOUDINARY_API_SECRET_KEY_NAME,
        tsOauthClientIdName: lambdaEnvVars.TS_OAUTH_CLIENT_ID_KEY_NAME,
        tsOauthClientSecretName: lambdaEnvVars.TS_OAUTH_CLIENT_SECRET_KEY_NAME,
        tsTailnetSuffixName: lambdaEnvVars.TS_TAILNET_SUFFIX_KEY_NAME,
      },
    },
  };
};

const isEnv = (value: string): value is StageName => {
  return (STAGE_NAMES as readonly string[]).includes(value);
};
