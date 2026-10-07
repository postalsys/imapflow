#!/bin/sh
set -e

# Entrypoint for the ImapFlow Apache James test container (apache/james:memory-*).
# The image ships configs whose IMAP, SMTP and POP3 servers point at conf/keystore but no
# keystore, so James refuses to start until one exists. A throwaway self-signed one is
# generated on every start; the test client accepts it with rejectUnauthorized: false.
keytool -genkeypair -noprompt -alias james -keyalg RSA -keysize 2048 -validity 3650 -storetype PKCS12 \
    -keystore /root/conf/keystore -storepass james72laBalle -keypass james72laBalle -dname "CN=localhost" >/dev/null 2>&1

# Pin the WebAdmin password (the default generates a random one per run) so the tests can
# create a fresh user for every test case
sed -i '/^password/d' /root/conf/webadmin.properties
echo "password=${JAMES_WEBADMIN_PASSWORD:-imapflow-test}" >> /root/conf/webadmin.properties

# The image's own entrypoint
exec java -Dlogback.configurationFile=/root/conf/logback.xml -Dworking.directory=/root/ -Djdk.tls.ephemeralDHKeySize=2048 \
    -Dextra.props=/root/conf/jvm.properties -cp @/root/jib-classpath-file org.apache.james.MemoryJamesServerMain
