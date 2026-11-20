package com.acme.user;

import com.acme.user.v1.GetUserReply;
import com.acme.user.v1.GetUserRequest;
import com.acme.user.v1.UserGrpc.UserImplBase;
import io.grpc.stub.StreamObserver;

// A second implementation of the same service, naming the base by import.
public class FakeUserService extends UserImplBase {
    @Override
    public void get(GetUserRequest request, StreamObserver<GetUserReply> responseObserver) {
        responseObserver.onCompleted();
    }
}
