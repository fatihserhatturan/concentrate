package com.acme.client;

import com.acme.billing.v1.BillingGrpc;
import com.acme.user.v1.GetUserRequest;
import com.acme.user.v1.SaveUserRequest;
import com.acme.user.v1.UserGrpc;
import io.grpc.Channel;
import java.util.Map;
import java.util.concurrent.TimeUnit;

public class UserClient {
    private final UserGrpc.UserBlockingStub blocking;
    private final UserGrpc.UserFutureStub future;
    private final UserGrpc.UserStub async;
    private final BillingGrpc.BillingBlockingStub billing;
    private final Map<String, String> cache;

    public UserClient(Channel channel, Map<String, String> cache) {
        this.blocking = UserGrpc.newBlockingStub(channel);
        this.future = UserGrpc.newFutureStub(channel);
        this.async = UserGrpc.newStub(channel);
        this.billing = BillingGrpc.newBlockingStub(channel);
        this.cache = cache;
    }

    public void fields(GetUserRequest request, SaveUserRequest save) {
        blocking.get(request);
        this.blocking.save(save);
        future.get(request);
        async.chat(null);
        billing.charge(null);
        cache.get("x");
    }

    public void withDeadline(GetUserRequest request) {
        blocking.withDeadlineAfter(1, TimeUnit.SECONDS).get(request);
    }

    public void parameter(UserGrpc.UserBlockingStub stub, GetUserRequest request) {
        stub.watch(request);
    }

    public void made(Channel channel, GetUserRequest request) {
        var inferred = UserGrpc.newBlockingStub(channel);
        inferred.get(request);
        UserGrpc.newBlockingStub(channel).withWaitForReady().save(null);
        UserGrpc.UserBlockingStub typed = UserGrpc.newBlockingStub(channel);
        typed.get(request);
    }

    // `get` on things that are no stub of the user service.
    public void unrelated(Map<String, String> other, Object stranger) {
        other.get("x");
        stranger.toString();
        var unknown = other.keySet();
        unknown.isEmpty();
    }
}
