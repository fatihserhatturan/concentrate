package com.acme.user.v1;

import io.grpc.Channel;
import io.grpc.stub.StreamObserver;

// Shaped like protoc-gen-grpc-java output for acme.user.v1.User.
@javax.annotation.Generated(value = "by gRPC proto compiler", comments = "Source: user.proto")
public final class UserGrpc {
    private UserGrpc() {}

    public static final String SERVICE_NAME = "acme.user.v1.User";

    public static UserStub newStub(Channel channel) {
        return new UserStub(channel);
    }

    public static UserBlockingStub newBlockingStub(Channel channel) {
        return new UserBlockingStub(channel);
    }

    public static UserFutureStub newFutureStub(Channel channel) {
        return new UserFutureStub(channel);
    }

    public interface AsyncService {
        default void get(GetUserRequest request, StreamObserver<GetUserReply> responseObserver) {}

        default void save(SaveUserRequest request, StreamObserver<SaveUserReply> responseObserver) {}

        default void watch(GetUserRequest request, StreamObserver<GetUserReply> responseObserver) {}

        default StreamObserver<SaveUserRequest> chat(StreamObserver<SaveUserReply> responseObserver) {
            return null;
        }
    }

    public abstract static class UserImplBase implements io.grpc.BindableService, AsyncService {
        @Override
        public final io.grpc.ServerServiceDefinition bindService() {
            return null;
        }
    }

    public static final class UserStub extends io.grpc.stub.AbstractAsyncStub<UserStub> {
        private UserStub(Channel channel) {}

        public void get(GetUserRequest request, StreamObserver<GetUserReply> responseObserver) {}

        public void save(SaveUserRequest request, StreamObserver<SaveUserReply> responseObserver) {}

        public StreamObserver<SaveUserRequest> chat(StreamObserver<SaveUserReply> responseObserver) {
            return null;
        }
    }

    public static final class UserBlockingStub extends io.grpc.stub.AbstractBlockingStub<UserBlockingStub> {
        private UserBlockingStub(Channel channel) {}

        public GetUserReply get(GetUserRequest request) {
            return null;
        }

        public SaveUserReply save(SaveUserRequest request) {
            return null;
        }

        public java.util.Iterator<GetUserReply> watch(GetUserRequest request) {
            return null;
        }
    }

    public static final class UserFutureStub extends io.grpc.stub.AbstractFutureStub<UserFutureStub> {
        private UserFutureStub(Channel channel) {}

        public com.google.common.util.concurrent.ListenableFuture<GetUserReply> get(GetUserRequest request) {
            return null;
        }
    }
}
