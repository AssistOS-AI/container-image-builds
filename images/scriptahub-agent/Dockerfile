FROM docker.io/assistos/ploinky-node@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669

# The application image runs no skill: skills execute only in the robot. The server and the reader come from
# the mounted checkout (node /code/deployment/start.mjs), so the pinned base is the whole image. The one check
# below fails the build if a base update drops what the server needs: git for publication and node:sqlite.
RUN git --version && node -e "new (require('node:sqlite').DatabaseSync)(':memory:').close()"
