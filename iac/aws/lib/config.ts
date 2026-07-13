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
    admin: string;
    images: string;
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
    virginia: {
      certificateArn: string;
    };
    admin: {
      userPoolId: string;
      userPoolClientId: string;
    };
    apiGateway: {
      apiUrl: string;
    };
    dsql: {
      clusterEndpoint: string;
      clusterArn: string;
    };
    proxy: {
      vpcId: string;
      privateSubnetId1: string;
      sgId: string;
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
    };
  };
  // 未設定の Lambda 用環境変数名。空でない場合、bin/cdk.ts が main stack に
  // Annotations.addError を付けて main のデプロイだけをブロックする
  // (deploy-role 等の他スタックはローカルで .env なしでもデプロイできるようにする)。
  missingLambdaEnvVars: string[];
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

// Lambda (main stack) 用の環境変数を検証する。未設定でも throw せず placeholder で
// 埋めて synth を通す。CDK は `cdk deploy <stack>` でも全スタックを synth するため、
// ここで throw すると deploy-role 等の main と無関係なスタックまでローカルで
// デプロイできなくなる。placeholder のまま main をデプロイする事故は、bin/cdk.ts の
// Annotations.addError (missingLambdaEnvVars) が main stack 選択時に synth を
// 失敗させることで防ぐ。
const getLambdaEnvVars = (): {
  values: z.infer<typeof lambdaEnvSchema>;
  missing: string[];
} => {
  const parsed = lambdaEnvSchema.safeParse({
    GH_APP_ID: process.env.GH_APP_ID,
    GH_APP_SECRET_PEM_KEY_NAME: process.env.GH_APP_SECRET_PEM_KEY_NAME,
    GH_WEBHOOK_SECRET_KEY_NAME: process.env.GH_WEBHOOK_SECRET_KEY_NAME,
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET_KEY_NAME: process.env.CLOUDINARY_API_SECRET_KEY_NAME,
  });

  if (parsed.success) {
    return { values: parsed.data, missing: [] };
  }

  const missing = parsed.error.issues.map((issue) => issue.path.join('.'));
  const placeholder = 'unset-local-placeholder';
  return {
    values: {
      GH_APP_ID: process.env.GH_APP_ID ?? placeholder,
      GH_APP_SECRET_PEM_KEY_NAME: process.env.GH_APP_SECRET_PEM_KEY_NAME ?? placeholder,
      GH_WEBHOOK_SECRET_KEY_NAME: process.env.GH_WEBHOOK_SECRET_KEY_NAME ?? placeholder,
      CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME ?? placeholder,
      CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY ?? placeholder,
      CLOUDINARY_API_SECRET_KEY_NAME: process.env.CLOUDINARY_API_SECRET_KEY_NAME ?? placeholder,
    },
    missing,
  };
};

const stageConfig: {
  [key in StageName]: Omit<AppParameter, 'cdkEnv' | 'ssm' | 'lambda' | 'missingLambdaEnvVars'>;
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
      admin: 'admin.shuntaka.tech',
      images: 'images.shuntaka.tech',
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
      admin: 'admin.shuntaka.dev',
      images: 'images.shuntaka.dev',
    },
  },
};

// tidb-proxy stack は dev / prd 共用のため stage 非依存。SSM Parameter Store
// の path は task 文書 (docs/source/98_tasks/2026-06-29-blog-api-tidb-proxy/index.md)
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

// tidb-proxy のログ分析基盤 (FireLens → Firehose → S3/Iceberg → Athena) も
// dev / prd 共用のため stage 非依存。SSM は tidb-proxy 本体と同じ
// `/tidb-proxy/...` 名前空間の `logs` 配下に出力する。設計は
// docs/source/98_tasks/2026-07-10-tidb-proxy-log-iceberg/index.md を参照。
export interface LogAnalyticsParameter {
  projectName: string;
  glue: {
    databaseName: string;
    tableName: string;
  };
  athena: {
    workGroupName: string;
  };
  firehose: {
    deliveryStreamName: string;
  };
  ssm: {
    // st-tidb-proxy スタックの出力を import する (読み取りのみ)
    proxy: {
      taskRole: string;
      logGroupName: string;
    };
    // 本スタックの出力 (ecspresso task def が参照)
    logs: {
      deliveryStreamName: string;
      firelensConfigS3ArnPrefix: string;
    };
  };
}

export const getLogAnalyticsConfig = (): LogAnalyticsParameter => {
  const proxyProjectName = 'tidb-proxy';
  return {
    projectName: 'tidb-proxy-logs',
    glue: {
      databaseName: 'tidb_proxy_logs',
      tableName: 'logs',
    },
    athena: {
      workGroupName: 'tidb-proxy-logs',
    },
    firehose: {
      deliveryStreamName: 'tidb-proxy-logs',
    },
    ssm: {
      proxy: {
        taskRole: `/${proxyProjectName}/proxy/task-role`,
        logGroupName: `/${proxyProjectName}/proxy/log-group-name`,
      },
      logs: {
        deliveryStreamName: `/${proxyProjectName}/logs/delivery-stream-name`,
        firelensConfigS3ArnPrefix: `/${proxyProjectName}/logs/firelens-config-s3-arn-prefix`,
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
      // us-east-1 (CloudFront 用証明書) の SSM に書き出す。読み取りは cross-region
      virginia: {
        certificateArn: `/${config.stageName.long}/${config.projectName.long}/virginia/certificate-arn`,
      },
      admin: {
        userPoolId: `/${config.stageName.long}/${config.projectName.long}/admin/user-pool-id`,
        userPoolClientId: `/${config.stageName.long}/${config.projectName.long}/admin/user-pool-client-id`,
      },
      apiGateway: {
        apiUrl: `/${config.stageName.long}/${config.projectName.long}/api-gateway/api-url`,
      },
      dsql: {
        clusterEndpoint: `/${config.stageName.long}/${config.projectName.long}/dsql/cluster-endpoint`,
        clusterArn: `/${config.stageName.long}/${config.projectName.long}/dsql/cluster-arn`,
      },
      proxy: {
        vpcId: '/tidb-proxy/vpc/id',
        privateSubnetId1: '/tidb-proxy/vpc/private-subnet-id-1',
        sgId: '/tidb-proxy/proxy/sg-id',
      },
    },
    lambda: {
      blogApi: {
        githubAppId: lambdaEnvVars.values.GH_APP_ID,
        githubAppSecretPemKeyName: lambdaEnvVars.values.GH_APP_SECRET_PEM_KEY_NAME,
        githubWebhookSecretKeyName: lambdaEnvVars.values.GH_WEBHOOK_SECRET_KEY_NAME,
        cloudinaryCloudName: lambdaEnvVars.values.CLOUDINARY_CLOUD_NAME,
        cloudinaryApiKey: lambdaEnvVars.values.CLOUDINARY_API_KEY,
        cloudinaryApiSecretKeyName: lambdaEnvVars.values.CLOUDINARY_API_SECRET_KEY_NAME,
      },
    },
    missingLambdaEnvVars: lambdaEnvVars.missing,
  };
};

const isEnv = (value: string): value is StageName => {
  return (STAGE_NAMES as readonly string[]).includes(value);
};
