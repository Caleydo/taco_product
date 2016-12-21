/**
 * Created by Samuel Gratzl on 28.11.2016.
 */

const Promise = require('bluebird');
const path = require('path');
const fs = require('fs');
const mkdirp = Promise.promisifyAll(require('mkdirp'));
const chalk = require('chalk');
const pkg = require('./package.json');
const argv = require('yargs-parser')(process.argv.slice(2));
const quiet = argv.quiet !== undefined;

const now = new Date();
const prefix = (n) => n < 10 ? ('0' + n) : n.toString();
const buildId = `${now.getUTCFullYear()}${prefix(now.getUTCMonth())}${prefix(now.getUTCDate())}-${prefix(now.getUTCHours())}${prefix(now.getUTCMinutes())}${prefix(now.getUTCSeconds())}`;
pkg.version = pkg.version.replace('SNAPSHOT', buildId);
const env = Object.assign({}, process.env);

function toRepoUrl(url) {
  return url.startsWith('http') ? url : `https://github.com/${url}`;
}


/**
 * spawns a child process
 * @param cmd command as array
 * @param args arguments
 * @param opts options
 */
function spawn(cmd, args, opts) {
  const spawn = require('child_process').spawn;
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    if (!quiet) {
      p.stdout.on('data', (data) => console.log(data.toString()));
      p.stderr.on('data', (data) => console.error(chalk.red(data.toString())));
    }
    p.on('close', (code) => code == 0 ? resolve() : reject(code));
  });
}

/**
 * run npm with the given args
 * @param cwd working directory
 * @param cmd the command to execute as a string
 * @return {*}
 */
function npm(cwd, cmd) {
  console.log(cwd, chalk.blue('running npm', cmd));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawn(npm, (cmd || 'install').split(' '), {cwd, env});
}

/**
 * runs docker command
 * @param cwd
 * @param cmd
 * @return {*}
 */
function docker(cwd, cmd) {
  console.log(cwd, chalk.blue('running docker', cmd));
  return spawn('docker', (cmd || 'build .').split(' '), {cwd, env});
}

function createQuietTerminalAdapter() {
  const impl = new require('yeoman-environment/adapter');
  impl.log = () => undefined;
  return impl;
}

/**
 * runs yo internally
 * @param generator
 * @param options
 * @param cwd
 */
function yo(generator, options, cwd) {
  const yeoman = require('yeoman-environment');
  // call yo internally
  const yeomanEnv = yeoman.createEnv([], {cwd, env}, quiet ? createQuietTerminalAdapter() : undefined);
  yeomanEnv.register(require.resolve('generator-phovea/generators/' + generator), 'phovea:' + generator);
  const runYo = () => new Promise((resolve, reject) => {
    try {
      console.log(cwd, chalk.blue('running yo phovea:' + generator));
      yeomanEnv.run('phovea:' + generator, options, resolve);
    } catch (e) {
      console.error('error', e, e.stack);
      reject(e);
    }
  });
  // move my own .yo-rc.json to avoid a conflict
  return spawn('mv', ['.yo-rc.json', '.yo-rc_tmp.json'])
    .then(runYo)
    .then(() => spawn('mv', ['.yo-rc_tmp.json', '.yo-rc.json']));
}

function cloneRepo(p, cwd) {
  p.repo = p.repo || `phovea/${p.name}`;
  p.branch = p.branch || 'master';
  console.log(cwd, chalk.blue(`running git clone --depth 1 -b ${p.branch} ${toRepoUrl(p.repo)} ${p.name}`));
  return spawn('git', ['clone', '--depth', '1', '-b', p.branch, toRepoUrl(p.repo), p.name], {cwd});
}

function moveToBuild(p, cwd) {
  return mkdirp.mkdirpAsync('build')
    .then(() => spawn('mv', [`${p.name}/dist/${p.name}.tar.gz`, `../build/${p.label}.tar.gz`], {cwd}));
}

function buildCommon(p, dir) {
  const hasAdditional = p.additional.length > 0;
  let act = spawn('rm', ['-rf', dir])
    .then(() => mkdirp.mkdirpAsync(dir))
    .then(() => cloneRepo(p, dir));
  if (hasAdditional) {
    act = act
      .then(() => Promise.all(p.additional.map((pi) => cloneRepo(pi, dir))));
  }
  return act;
}

function buildWebApp(p, dir) {
  console.log(dir, chalk.blue('building web application:'), p.label);
  const name = p.name;
  const hasAdditional = p.additional.length > 0;
  let act = buildCommon(p, dir);
  //let act = Promise.resolve(null);
  if (hasAdditional) {
    act = act
      .then(() => yo('workspace', {noAdditionals: true}, dir))
      .then(() => npm(dir, 'install'));
    //test all modules
    if (hasAdditional && !argv.skipTests) {
      act = act.then(() => Promise.all(p.additional.map((pi) => npm(dir, `run test:${pi.name}`))));
    }
    act = act
      .then(() => npm(dir, `run dist:${p.name}`));
  } else {
    act = act
      .then(() => npm(dir + '/' + name, 'install'))
      .then(() => npm(dir + '/' + name, 'run dist'));
  }
  act = act
    .then(() => docker(dir + '/' + name, `build -t ${p.label}:${pkg.version} -f deploy/Dockerfile .`))
    .then(() => moveToBuild(p, dir));
  act.catch((error) => {
    console.error('ERROR', error);
  });
  return act.then(() => `${p.label}:${pkg.version}`);
}

function buildServerApp(p, dir) {
  console.log(dir, chalk.blue('building server package:'), p.label);
  const name = p.name;
  const hasAdditional = p.additional.length > 0;

  // let act = buildCommon(p, dir);
  act = act
    .then(() => yo('workspace', {noAdditionals: true}, dir));

  act = act
    .then(() => console.log(chalk.yellow('create test environment')))
    .then(() => npm(dir + '/' + name, 'run build'))
    .then(() => Promise.all(p.additional.map((pi) => npm(dir + '/' + pi.name, `run build`))));

  //copy all together
  act = act
    .then(() => spawn('mkdir', ['-p', `${dir}/build`]))
    .then(() => spawn('cp', ['-r', `${dir}/${name}/build/source`, `${dir}/build/`]))
    .then(() => Promise.all(p.additional.map((pi) => spawn('cp', ['-r', `${dir}/${pi.name}/build/source/*`, `${dir}/build/source/`]))));

  //let act = Promise.resolve([]);

  //copy main deploy thing and create a docker out of it
  act = act
    .then(() => spawn('cp', ['-r', `${dir}/${name}/deploy`, `${dir}/`]))
    .then(() => docker(dir, `build -t ${p.label}:${pkg.version} -f deploy/Dockerfile .`));

  act.catch((error) => {
    console.error('ERROR', error);
  });
  return act.then(() => `${p.label}:${pkg.version}`);
}

if (require.main === module) {
  if (argv.skipTests) {
    // if skipTest option is set, skip tests
    console.log(chalk.blue('skipping tests'));
    env.PHOVEA_SKIP_TESTS = true;
  }
  const descs = require('./phovea_product');
  const all = Promise.all(descs.map((d, i) => {
    d.additional = d.additional || []; //default values
    d.label = d.label || d.name;
    switch (d.type) {
      case 'web':
        return buildWebApp(d, './tmp' + i);
      case 'server':
        return buildServerApp(d, './tmp' + i);
      default:
        console.error(chalk.red('unknown product type: ' + d.type));
        return Promise.resolve(null);
    }
  }));

  all.then((images) => {
    console.log('done');
    console.log('docker images');
    console.log(' ', chalk.blue(images.join('\n  ')));
  });
}
