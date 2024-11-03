import axios from "axios";
import Sequence from "../src";
import { LayerConfig } from "../src/interfaces/layerConfig.interface";
import { delay } from "../src/utils/delay";

const taskFetchUser: LayerConfig = {
    name: "FetchUser",
    execute: async () => {
        console.log("Fetching user data from API...");
        const response = await axios.get(
            "https://jsonplaceholder.typicode.com/users/1"
        );
        return response.data;
    },
    priority: 1,
};

const taskFetchPosts: LayerConfig = {
    name: "FetchPosts",
    execute: async () => {
        console.log("Fetching posts from API...");
        const response = await axios.get(
            "https://jsonplaceholder.typicode.com/posts"
        );
        return response.data;
    },
    priority: 1,
};

const taskProcessUserData: LayerConfig = {
    name: "ProcessUserData",
    execute: async (userData: any) => {
        console.log("Processing user data...");
        console.log("Received user data:", userData);
        // Simulate processing time
        await delay(500);
        const processedUser = {
            id: userData.id,
            name: userData.name.toUpperCase(),
            email: userData.email,
        };
        console.log("Processed user data:", processedUser);
        return processedUser;
    },
    dependsOn: ["FetchUser"],
    priority: 2,
};

const taskProcessPosts: LayerConfig = {
    name: "ProcessPosts",
    execute: async (posts: any) => {
        console.log("Processing posts...");
        console.log("Received posts:", posts.slice(0, 2)); // Log first 2 posts
        // Simulate processing time
        await delay(700);
        const processedPosts = posts.filter((post: any) => post.userId === 1);
        console.log("Processed posts:", processedPosts.slice(0, 2)); // Log first 2 processed posts
        return processedPosts;
    },
    dependsOn: ["FetchPosts"],
    priority: 2,
};

const taskAggregateData: LayerConfig = {
    name: "AggregateData",
    execute: async (processedUser: any, processedPosts: any) => {
        console.log("Aggregating data...");
        console.log("User data:", processedUser);
        console.log("Posts data:", processedPosts.slice(0, 2)); // Log first 2 posts
        // Simulate processing time
        await delay(600);
        const aggregatedData = {
            user: processedUser,
            posts: processedPosts,
        };
        console.log("Aggregated data:", aggregatedData);
        return aggregatedData;
    },
    dependsOn: ["ProcessUserData", "ProcessPosts"],
    priority: 3,
};

const taskStoreData: LayerConfig = {
    name: "StoreData",
    execute: async (aggregatedData: any) => {
        console.log("Storing data...");
        console.log("Data to store:", aggregatedData);
        // Simulate storage time
        await delay(400);
        return { status: "Data stored successfully", data: aggregatedData };
    },
    dependsOn: ["AggregateData"],
    priority: 4,
};

const taskSendNotification: LayerConfig = {
    name: "SendNotification",
    execute: async (storeResult: any) => {
        console.log("Sending notification...");
        console.log("Store result:", storeResult);
        // Simulate sending notification
        await delay(300);
        return { status: "Notification sent", result: storeResult };
    },
    dependsOn: ["StoreData"],
    priority: 5,
};

// Run the sequence
(async () => {
    const sequence = new Sequence({
        verbose: true,
        maxConcurrency: 3, // Increased concurrency
    });

    sequence
        .addLayer(taskFetchUser)
        .addLayer(taskFetchPosts)
        .addLayer(taskProcessUserData)
        .addLayer(taskProcessPosts)
        .addLayer(taskAggregateData)
        .addLayer(taskStoreData)
        .addLayer(taskSendNotification);

    // visualizeGraph(sequence["dag"]);
    try {
        await sequence.build();
        console.log("Final context:", sequence.context);
    } catch (error) {
        console.error("Error during sequence execution:", error);
    }
})();
