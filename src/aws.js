const { EC2Client, RunInstancesCommand, TerminateInstancesCommand, waitUntilInstanceRunning  } = require('@aws-sdk/client-ec2');

const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh'
    ];
  }

  if (!config.input.numRunners || config.input.numRunners === '1') {
    // If num runners not specified or just one, we download the runner software and start it as in the original action
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.313.0/actions-runner-linux-${RUNNER_ARCH}-2.313.0.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.313.0.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh'
    ];
  }

  const base = [
    '#!/bin/bash',
    'mkdir actions-runner && cd actions-runner',
    `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
    'source pre-runner-script.sh',
    'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
    'curl -O -L https://github.com/actions/runner/releases/download/v2.313.0/actions-runner-linux-${RUNNER_ARCH}-2.313.0.tar.gz',
  ]
  for (let i = 1; i <= Number(config.input.numRunners); i++) {
    // Install each runner in a separate directory
    base.push(`mkdir ${i} && cd ${i}`);
    base.push('tar xzf ../actions-runner-linux-${RUNNER_ARCH}-2.313.0.tar.gz');
    base.push(`export RUNNER_ALLOW_RUNASROOT=1`);
    base.push(`./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label} --name ${label}-${i}`);
    // Install each runner as a service
    base.push('sudo ./svc.sh install');
    base.push('sudo ./svc.sh start');
    base.push('cd ..');
  }
  return base;
}

async function startEc2Instance(label, githubRegistrationToken) {
  const ec2 = new EC2Client();

  const userData = buildUserDataScript(githubRegistrationToken, label);

  const params = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MaxCount: 1,
    MinCount: 1,
    SecurityGroupIds: [config.input.securityGroupId],
    SubnetId: config.input.subnetId,
    UserData: Buffer.from(userData.join('\n')).toString('base64'),
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: config.tagSpecifications
  };

  try {
    const result = await ec2.send(new RunInstancesCommand(params));
    const ec2InstanceId = result.Instances[0].InstanceId;
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function terminateEc2Instance() {
  const ec2 = new EC2Client();

  const params = {
    InstanceIds: [config.input.ec2InstanceId]
  };

  try {
    await ec2.send(new TerminateInstancesCommand(params));
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new EC2Client();
  try {
    core.info(`Cheking for instance ${ec2InstanceId} to be up and running`)
    await waitUntilInstanceRunning(
      {
        client: ec2,
        maxWaitTime: 300,
      }, {
      Filters: [
        {
          Name: 'instance-id',
          Values: [
            ec2InstanceId,
          ],
        },
      ],
    });

    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning
};
