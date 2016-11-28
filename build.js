/**
 * Created by Samuel Gratzl on 28.11.2016.
 */

const Promise = require('bluebird');
const path = require('path');
const fs = require('fs');
const mkdirp = Promise.promisifyAll(require('mkdirp'));
const chalk = require('chalk');

function toRepoUrl(url) {
  return url.startsWith('http') ? url : `https://github.com/${url}`;
}

function spawn(cmd, args, opts) {
  const spawn = require('child_process').spawn;
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    p.stdout.on('data', (data) => console.log(data.toString()));
    p.stderr.on('data', (data) => console.error(chalk.red(data.toString())));

    p.on('close', (code) => code == 0 ? resolve() : reject(code));
  });
}

function npm(cwd, cmd) {
  console.log(chalk.blue('running npm', cmd));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawn(npm, (cmd || 'install').split(' '), {cwd});
}

function yo(generator, cwd) {
  const yeoman = require('yeoman-environment');
  // call yo internally
  const env = yeoman.createEnv([], {
    cwd: cwd
  });
  env.register(require.resolve('geneator-phovea/generators/' + generator), 'phovea:' + generator);
  return new Promise((resolve, reject) => {
    try {
      console.log('running yo phovea:' + generator);
      env.run('phovea:' + generator, resolve);
    } catch (e) {
      console.error('error', e, e.stack);
      reject(e);
    }
  });
}

function cloneRepo(p, cwd) {
  p.branch = p.branch || 'master';
  console.log(chalk.blue(`running git clone -b ${p.branch} ${toRepoUrl(p.repo)}`));
  return spawn('git', ['clone', '-b', p.branch, toRepoUrl(p.repo)], {cwd});
}

function moveToBuild(p, cwd) {
  return mkdirp.mkdirpAsync('build')
      .then(() => spawn('mv', [`${p.name}/dist/*.tar.gz`, '../build/'], {cwd}));
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
  const name = p.name;
  const hasAdditional = p.additional.length > 0;
  console.log(chalk.blue('Building web application:'), p.name);
  let act = buildCommon(p, dir);
  if (hasAdditional) {
    act = act
        .then(() => yo('ueber', dir))
        .then(() => npm(dir, 'install'))
        .then(() => npm(dir, `run dist:${p.name}`));
  } else {
    act = act
        .then(() => npm(dir + '/' + name, 'install'))
        .then(() => npm(dir + '/' + name, 'run dist'));
  }
  act = act.then(() => moveToBuild(p, dir));
  act.catch((error) => {
    console.error('ERROR', error);
  });
  return act;
}

function buildApiApp(p, dir) {
  console.log(chalk.blue('Building api package:'), p.name);
  const hasAdditional = p.additional.length > 0;

  let act = buildCommon(p, dir);
  act = act.then(() => cloneRepo({repo: 'phovea/phovea_server', branch: 'master'}, dir));

  console.error(chalk.red.bold('TODO building', p.name));
  act.catch((error) => {
    console.error('ERROR', error);
  });
  return act;
}

function buildServiceApp(p, dir) {
  console.log(chalk.blue('Building api package:'), p.name);
  const hasAdditional = p.additional.length > 0;

  let act = buildCommon(p, dir);
  console.error(chalk.red.bold('TODO building', p.name));
  act.catch((error) => {
    console.error('ERROR', error);
  });
  return act;
}

if (require.main === module) {
  const descs = require('./phovea_product');
  descs.forEach((d, i) => {
    d.additional = d.additional || []; //default values
    switch (d.type) {
      case 'web':
        return buildWebApp(d, './tmp' + i);
      case 'api':
        return buildApiApp(d, './tmp' + i);
      case 'service':
        return buildServiceApp(d, './tmp' + i);
      default:
        console.error(chalk.red('unknown product type: ' + d.type));
    }
  });
}