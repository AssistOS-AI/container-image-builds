#define _GNU_SOURCE

#include <arpa/inet.h>
#include <dlfcn.h>
#include <netinet/in.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

typedef int (*bind_function)(int, const struct sockaddr *, socklen_t);

static bind_function next_bind;

static void fail_closed(const char *message) {
    const ssize_t write_result = write(STDERR_FILENO, message, strlen(message));
    (void)write_result;
    _exit(126);
}

__attribute__((constructor)) static void initialize_docservice_bind_scope(void) {
    const char *scope = getenv("ONLYOFFICE_DOCSERVICE_BIND_SCOPE");
    if (scope == NULL || strcmp(scope, "docservice-port-8000") != 0) {
        fail_closed("OnlyOffice DocService bind interposer loaded outside its exact v5 scope.\n");
    }

    union {
        void *object;
        bind_function function;
    } resolved = { .object = dlsym(RTLD_NEXT, "bind") };
    if (resolved.object == NULL) {
        fail_closed("OnlyOffice DocService bind interposer could not resolve bind().\n");
    }
    next_bind = resolved.function;
}

int bind(int socket_fd, const struct sockaddr *address, socklen_t address_length) {
    if (next_bind == NULL) {
        fail_closed("OnlyOffice DocService bind interposer is uninitialized.\n");
    }
    if (address != NULL && address->sa_family == AF_INET
        && address_length >= (socklen_t)sizeof(struct sockaddr_in)) {
        const struct sockaddr_in *input = (const struct sockaddr_in *)address;
        if (input->sin_port == htons(8000) && input->sin_addr.s_addr == htonl(INADDR_ANY)) {
            struct sockaddr_in loopback = *input;
            loopback.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
            return next_bind(socket_fd, (const struct sockaddr *)&loopback, sizeof(loopback));
        }
    }
    if (address != NULL && address->sa_family == AF_INET6
        && address_length >= (socklen_t)sizeof(struct sockaddr_in6)) {
        const struct sockaddr_in6 *input = (const struct sockaddr_in6 *)address;
        if (input->sin6_port == htons(8000) && IN6_IS_ADDR_UNSPECIFIED(&input->sin6_addr)) {
            struct sockaddr_in6 loopback = *input;
            loopback.sin6_addr = in6addr_loopback;
            return next_bind(socket_fd, (const struct sockaddr *)&loopback, sizeof(loopback));
        }
    }
    return next_bind(socket_fd, address, address_length);
}
