/*
 * uv-pool-waker: wakes this process's libuv thread-pool workers (macOS only).
 *
 * Why: the four "libuv-worker" threads sleep in pthread_cond_wait() on one
 * condition variable and are woken by pthread_cond_signal() whenever work is
 * queued. On macOS that condvar has been seen to lose a wakeup: libpthread's
 * user-space counters record every waiter as already signalled (L == U) while
 * the kernel still has them all blocked in __psynch_cvwait (S < L). From then
 * on every signal is a no-op that never reaches the kernel, the workers never
 * wake, and every fs.* / dns.lookup / node-pty write in the process queues
 * forever — the "terminals stop taking input until a restart" freeze.
 *
 * The cure: interrupt the blocked waits with a signal. A no-op handler
 * installed without SA_RESTART makes __psynch_cvwait return EINTR, which
 * libpthread treats as a spurious wakeup (and re-syncs the condvar's
 * counters for); libuv's worker loop then re-checks its queue and drains it.
 * Waking an idle worker that was not stuck is harmless: it finds the queue
 * empty and goes back to sleep.
 *
 * Threads are found by name through the Mach thread list, so nothing here
 * depends on libuv's (static, unexported) globals or on the Electron build.
 *
 * Plain C against the stable N-API ABI; the few N-API declarations are
 * spelled out below so the build needs no Node headers (see
 * scripts/build-uv-pool-waker.mjs).
 */
#include <errno.h>
#include <mach/mach.h>
#include <pthread.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

extern napi_status napi_create_function(napi_env env, const char* utf8name, size_t length,
                                        napi_callback cb, void* data, napi_value* result);
extern napi_status napi_set_named_property(napi_env env, napi_value object, const char* utf8name,
                                           napi_value value);
extern napi_status napi_create_object(napi_env env, napi_value* result);
extern napi_status napi_create_int32(napi_env env, int32_t value, napi_value* result);
extern napi_status napi_create_string_utf8(napi_env env, const char* str, size_t length,
                                           napi_value* result);

#define WORKER_THREAD_NAME "libuv-worker"
#define WAKE_SIGNAL SIGINFO

static int handler_installed = 0;

static void noop_handler(int sig) { (void)sig; }

/*
 * SIGINFO's default disposition is "discard", and nothing in Electron or Node
 * uses it, so a no-op handler changes nothing observable except that a
 * delivered SIGINFO interrupts the receiving thread's blocking syscall. The
 * handler stays installed: removing it while a sent signal is still pending
 * would discard that signal and leave the worker asleep. A handler someone
 * else installed is never replaced.
 */
static const char* ensure_handler(void) {
  if (handler_installed) return NULL;
  struct sigaction current;
  if (sigaction(WAKE_SIGNAL, NULL, &current) != 0) return "sigaction-read-failed";
  if ((current.sa_flags & SA_SIGINFO) != 0 || (current.sa_handler != SIG_DFL &&
                                                current.sa_handler != SIG_IGN)) {
    return "signal-in-use";
  }
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = noop_handler;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = 0; /* no SA_RESTART: the wait must return EINTR, not resume */
  if (sigaction(WAKE_SIGNAL, &sa, NULL) != 0) return "sigaction-write-failed";
  handler_installed = 1;
  return NULL;
}

static napi_value result_object(napi_env env, int found, int signalled, const char* error) {
  napi_value out, value;
  napi_create_object(env, &out);
  napi_create_int32(env, found, &value);
  napi_set_named_property(env, out, "found", value);
  napi_create_int32(env, signalled, &value);
  napi_set_named_property(env, out, "signalled", value);
  if (error) {
    napi_create_string_utf8(env, error, (size_t)-1, &value);
    napi_set_named_property(env, out, "error", value);
  }
  return out;
}

/* wakeThreadpoolWorkers(): { found, signalled, error? } */
static napi_value wake_threadpool_workers(napi_env env, napi_callback_info info) {
  (void)info;
  const char* error = ensure_handler();
  if (error) return result_object(env, 0, 0, error);

  thread_act_array_t threads = NULL;
  mach_msg_type_number_t count = 0;
  if (task_threads(mach_task_self(), &threads, &count) != KERN_SUCCESS) {
    return result_object(env, 0, 0, "task-threads-failed");
  }
  int found = 0, signalled = 0;
  pthread_t self = pthread_self();
  for (mach_msg_type_number_t i = 0; i < count; i++) {
    pthread_t thread = pthread_from_mach_thread_np(threads[i]);
    char name[64] = {0};
    if (thread && thread != self && pthread_getname_np(thread, name, sizeof name) == 0 &&
        strcmp(name, WORKER_THREAD_NAME) == 0) {
      found++;
      if (pthread_kill(thread, WAKE_SIGNAL) == 0) signalled++;
    }
    mach_port_deallocate(mach_task_self(), threads[i]);
  }
  vm_deallocate(mach_task_self(), (vm_address_t)threads, count * sizeof(thread_act_t));
  return result_object(env, found, signalled, NULL);
}

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env,
                                                                         napi_value exports) {
  napi_value fn;
  if (napi_create_function(env, "wakeThreadpoolWorkers", (size_t)-1, wake_threadpool_workers, NULL,
                           &fn) == 0) {
    napi_set_named_property(env, exports, "wakeThreadpoolWorkers", fn);
  }
  return exports;
}

/* Node-API version this addon targets (N-API 1 suffices). */
__attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1(void) {
  return 8;
}
