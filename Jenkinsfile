node {
 stage('Checkout') {
   checkout scm
 }

 stage('Before Install') {
   def nodeHome = tool 'node-v7'
   env.PATH="${env.PATH}:${nodeHome}/bin"
   def dockerHome = tool 'docker'
   env.PATH="${env.PATH}:${dockerHome}/bin"
 }

 stage('Install') {
   sh 'node -v'
   sh 'npm --version'
   sh 'docker --version'
   sh 'npm install'
 }

 stage('Build') {
   try {
     withCredentials([usernameColonPassword(credentialsId: 'PHOVEA_GITHUB_CREDENTIALS', variable: 'PHOVEA_GITHUB_CREDENTIALS')]) {
       docker.withRegistry("https://922145058410.dkr.ecr.eu-central-1.amazonaws.com", "ecr:eu-central-1:PHOVEA_AWS_CREDENTIALS") {
         docker.withRegistry("", "PHOVEA_DOCKER_HUB_CREDENTIALS") {
           wrap([$class: 'Xvfb']) {
            sh 'node build.js --skipTests --skipSaveImage --noDefaultTags --pushExtra=latest --pushTo=922145058410.dkr.ecr.eu-central-1.amazonaws.com/caleydo'
         }
        }
      }
     }
     currentBuild.result = "SUCCESS"
   } catch (e) {
     // if any exception occurs, mark the build as failed
     currentBuild.result = 'FAILURE'
     throw e
   } finally {
     // always clean up
     sh 'npm prune'
     sh 'rm node_modules -rf'
   }
 }

 stage('Post Build') {
   archiveArtifacts artifacts: 'build/*'
 }
}
