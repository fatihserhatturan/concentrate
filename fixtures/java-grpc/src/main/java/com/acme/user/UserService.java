package com.acme.user;

import com.acme.user.v1.GetUserReply;
import com.acme.user.v1.GetUserRequest;
import com.acme.user.v1.SaveUserReply;
import com.acme.user.v1.SaveUserRequest;
import com.acme.user.v1.UserGrpc;
import io.grpc.stub.StreamObserver;

public class UserService extends UserGrpc.UserImplBase {
    @Override
    public void get(GetUserRequest request, StreamObserver<GetUserReply> responseObserver) {
        responseObserver.onCompleted();
    }

    @Override
    public void save(SaveUserRequest request, StreamObserver<SaveUserReply> responseObserver) {
        responseObserver.onCompleted();
    }

    @Override
    public void watch(GetUserRequest request, StreamObserver<GetUserReply> responseObserver) {
        responseObserver.onCompleted();
    }

    @Override
    public StreamObserver<SaveUserRequest> chat(StreamObserver<SaveUserReply> responseObserver) {
        return null;
    }

    // Same shape as an rpc, but the generated base declares no `describe`: a helper.
    public void describe(GetUserRequest request, StreamObserver<GetUserReply> responseObserver) {
        responseObserver.onCompleted();
    }

    void notPublic(GetUserRequest request, StreamObserver<GetUserReply> responseObserver) {
        responseObserver.onCompleted();
    }

    public static void helper() {}
}
