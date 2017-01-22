node {
 stage('Checkout') {
   checkout scm
 }

 stage('Before Install') {
   def nodeHome = tool 'node-v7'
   env.PATH="${env.PATH}:${nodeHome}/bin"
 }

 stage('Install') {
   sh 'node -v'
   sh 'npm --version'
   sh 'npm install'
 }

 stage('Build') {
   try {
     withCredentials([usernameColonPassword(credentialsId: '8d0d3e70-a5ee-4180-b3b8-65a75d31eae8', variable: 'PHOVEA_GITHUB_CREDENTIALS')]) {
       docker.withRegistry("https://922145058410.dkr.ecr.eu-central-1.amazonaws.com", "ecr:eu-central-1:17d21673-22fc-48b7-84d8-18b5f58fbc7a") {
         wrap([$class: 'Xvfb']) {
          sh 'node build.js --skipTests --skipSaveImages --pushTo=922145058410.dkr.ecr.eu-central-1.amazonaws.com/caleydo'
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
